import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runResearch, parseClaudeContent, researchVerdict, MAX_SOURCES, STOPPED_EARLY_NOTE } from "./research.js";
import { logger } from "../logger.js";
import { wantsResearch } from "./research-types.js";
import type { ClaudeClient, ClaudeMessage, ClaudeRequest } from "../services/claude-api.js";
import { MAX_PAUSE_CONTINUATIONS } from "../services/claude-api.js";

const claudeChoice = { provider: "claude", model: "claude-opus-5-5" } as const;
const geminiChoice = { provider: "gemini", model: "gemini-3.8-flash" } as const;

// --- Claude fixtures: the block shapes of a web-search answer ---
const result = (url: string, title: string, page_age: string | null = null) => ({ type: "web_search_result", url, title, page_age, encrypted_content: "enc" });
const searchBlock = (results: unknown) => ({ type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: results });
const searchError = (error_code: string) => searchBlock({ type: "web_search_tool_result_error", error_code });
const serverUse = () => ({ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q" } });
const cite = (url: string, title: string | null, cited_text: string) => ({ type: "web_search_result_location", url, title, cited_text, encrypted_index: "idx" });
const textBlock = (text: string, citations: unknown[] | null = null) => ({ type: "text", text, citations });
const message = (content: unknown[], stop_reason = "end_turn", searches: number | null = 1): ClaudeMessage => ({
  model: "claude-opus-5-5", stop_reason: stop_reason as ClaudeMessage["stop_reason"], content: content as ClaudeMessage["content"],
  usage: searches === null ? null : { server_tool_use: { web_search_requests: searches } },
});
function fakeClaude(messages: ClaudeMessage[], seen: ClaudeRequest[] = []): ClaudeClient {
  let next = 0;
  return { beta: { messages: { stream(params) {
    seen.push(structuredClone(params));
    const answer = messages[next++];
    if (!answer) throw new Error("unexpected extra Claude call");
    return { finalMessage: async () => answer };
  } } } };
}

const A = "https://www.reuters.com/markets/a";
const B = "https://example.org/b";
const C = "https://news.example.com/c";

test("Claude: results list, citations become [S#] markers (cited pages first), dedupe, search count", async () => {
  const seen: ClaudeRequest[] = [];
  const client = fakeClaude([message([
    serverUse(),
    searchBlock([result(A, "Reuters A", "April 3, 2026"), result(B, "Example B"), result(`${A}#frag`, "Reuters A again"), result(C, "News C", "2 days ago")]),
    textBlock("Dobanda a crescut. ", [cite(B, "Example B", "dobanda a crescut la 6%")]),
    textBlock("Ministerul a confirmat", [cite(A, "Reuters A", "ministerul a confirmat"), cite(B, "Example B", "a doua citare")]),
    textBlock(" si atat."),
  ], "end_turn", 2)], seen);
  const brief = await runResearch("system", "user", claudeChoice, { client });
  // B is cited first, so it is S1; C was only a search result, so it comes last.
  assert.deepEqual(brief.sources.map((s) => [s.id, s.url]), [["S1", B], ["S2", A], ["S3", C]]);
  assert.equal(brief.text, "Dobanda a crescut.[S1] Ministerul a confirmat[S2][S1] si atat.");
  assert.equal(brief.searches, 2);
  assert.equal(brief.calls, 1);
  assert.equal(brief.provider, "claude");
  assert.equal(brief.model, "claude-opus-5-5");
  const reuters = brief.sources[1]!;
  assert.equal(reuters.title, "Reuters A");
  assert.equal(reuters.publisher, "reuters.com");
  assert.equal(reuters.published_at, "April 3, 2026");
  assert.equal(reuters.cited_text, "ministerul a confirmat");
  assert.equal(brief.sources[2]!.cited_text, "");
  assert.equal(brief.sources[0]!.published_at, "");
  // The request: web search 20260209 with the cap, Romania, plain text (no structured output), one call.
  assert.equal(seen.length, 1);
  const request = seen[0]!;
  assert.deepEqual(request.tools, [{ type: "web_search_20260209", name: "web_search", max_uses: 5, user_location: { type: "approximate", country: "RO", timezone: "Europe/Bucharest" } }]);
  assert.equal(request.output_config?.format, undefined);
  assert.equal(request.output_config?.effort, "medium");
  assert.equal(request.model, "claude-opus-5-5");
  assert.deepEqual(request.messages, [{ role: "user", content: "user" }]);
  assert.match(String(request.system), /^system\n/);
  assert.match(String(request.system), /at most 5 web searches/);
});

test("Claude: the cap comes from the options and is the tool's max_uses", async () => {
  const seen: ClaudeRequest[] = [];
  await runResearch("s", "u", claudeChoice, { maxSearches: 2, client: fakeClaude([message([textBlock("x", [cite(A, "t", "q")])])], seen) });
  assert.equal((seen[0]!.tools![0] as { max_uses: number }).max_uses, 2);
});

test("Claude: a search error is an object, not a list, and does not break the brief", async () => {
  const brief = await runResearch("s", "u", claudeChoice, { client: fakeClaude([message([
    serverUse(), searchError("unavailable"),
    serverUse(), searchBlock([result(A, "Reuters A")]),
    textBlock("Fapt.", [cite(A, "Reuters A", "fapt")]),
  ], "end_turn", 2)]) });
  assert.deepEqual(brief.sources.map((s) => s.url), [A]);
  assert.equal(brief.text, "Fapt.[S1]");
  // Every search failed: notes but no sources. The loop turns that into RESEARCH_EMPTY.
  const empty = await runResearch("s", "u", claudeChoice, { client: fakeClaude([message([serverUse(), searchError("max_uses_exceeded"), textBlock("Nu am gasit nimic.")], "end_turn", 1)]) });
  assert.deepEqual(empty.sources, []);
  assert.equal(empty.text, "Nu am gasit nimic.");
});

test("Claude: searches fall back to counting server_tool_use blocks when usage is missing", async () => {
  const brief = await runResearch("s", "u", claudeChoice, { client: fakeClaude([message([
    serverUse(), searchBlock([result(A, "t")]), serverUse(), searchBlock([result(B, "t")]), textBlock("ok"),
  ], "end_turn", null)]) });
  assert.equal(brief.searches, 2);
});

test("Claude: sources come only from results and citations; bad URLs are dropped; cap of 20 never cuts a cited page", async () => {
  const many = Array.from({ length: 25 }, (_, i) => result(`https://site${i}.example.com/p`, `Page ${i}`));
  const bad = [result("javascript:alert(1)", "x"), result("ftp://example.com/f", "x"), result(`https://example.com/${"a".repeat(2100)}`, "x"), result("not a url", "x")];
  const brief = await runResearch("s", "u", claudeChoice, { client: fakeClaude([message([
    searchBlock([...bad, ...many]),
    textBlock("Se citeaza ultima pagina.", [cite("https://site24.example.com/p", "Page 24", "q"), cite("https://made-up.example.net/", "Invented", "q")]),
    textBlock("Link inventat in text: https://free-text.example.org/x"),
  ])]) });
  assert.equal(brief.sources.length, MAX_SOURCES);
  assert.equal(brief.sources[0]!.url, "https://site24.example.com/p");
  assert.equal(brief.sources[0]!.id, "S1");
  // A citation counts as a source even when the results did not list it; free text never does.
  assert.equal(brief.sources[1]!.url, "https://made-up.example.net/");
  assert.ok(!brief.sources.some((s) => s.url.includes("free-text") || s.url.startsWith("javascript") || s.url.startsWith("ftp") || s.url.length > 2048));
  assert.equal(brief.sources[19]!.id, "S20");
  assert.equal(new Set(brief.sources.map((s) => s.url)).size, 20);
});

test("parseClaudeContent: a citation without a title takes the result's title; no citations means no markers", () => {
  const parsed = parseClaudeContent([
    searchBlock([result(A, "Titlul din rezultat")]), textBlock("Fapt.", [cite(A, null, "q")]), textBlock(" Altul.", null),
  ] as ClaudeMessage["content"]);
  assert.equal(parsed.sources[0]!.title, "Titlul din rezultat");
  assert.equal(parsed.text, "Fapt.[S1] Altul.");
});

test("Claude: pause_turn is resumed with the paused content unchanged, no extra user message; the cap holds", async () => {
  const seen: ClaudeRequest[] = [];
  const firstContent = [serverUse(), searchBlock([result(A, "Reuters A")]), textBlock("Prima parte. ", [cite(A, "Reuters A", "q")])];
  const brief = await runResearch("s", "u", claudeChoice, { maxSearches: 5, client: fakeClaude([
    message(firstContent, "pause_turn", 2),
    message([serverUse(), searchBlock([result(B, "Example B")]), textBlock("A doua parte.", [cite(B, "Example B", "q")])], "end_turn", 1),
  ], seen) });
  assert.equal(brief.calls, 2);
  assert.equal(brief.searches, 3);
  assert.equal(brief.text, "Prima parte.[S1] A doua parte.[S2]");
  assert.deepEqual(brief.sources.map((s) => s.url), [A, B]);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1]!.messages, [{ role: "user", content: "u" }, { role: "assistant", content: firstContent }]);
  // Two searches were used, so the resumed call may use only three more.
  assert.equal((seen[0]!.tools![0] as { max_uses: number }).max_uses, 5);
  assert.equal((seen[1]!.tools![0] as { max_uses: number }).max_uses, 3);
});

test("Claude: pause_turn continuations are capped at 3 (4 calls in all)", async () => {
  const seen: ClaudeRequest[] = [];
  const paused = (n: number) => message([textBlock(`Parte ${n}. `, [cite(`https://p${n}.example.com/`, `P${n}`, "q")])], "pause_turn", 0);
  const brief = await runResearch("s", "u", claudeChoice, { client: fakeClaude([1, 2, 3, 4, 5].map(paused), seen) });
  assert.equal(MAX_PAUSE_CONTINUATIONS, 3);
  assert.equal(seen.length, 4);
  assert.equal(brief.calls, 4);
  // Still paused after the last continuation: the partial notes are kept and marked.
  assert.equal(brief.text, `Parte 1.[S1] Parte 2.[S2] Parte 3.[S3] Parte 4.[S4]\n\n${STOPPED_EARLY_NOTE}`);
  assert.equal(brief.sources.length, 4);
  // The assistant message grows with every paused turn.
  assert.equal((seen[3]!.messages[1]!.content as unknown[]).length, 3);
});

/** The warnings logged while `run` works. */
async function warningsOf(run: () => Promise<unknown>): Promise<Array<{ msg: string; data?: Record<string, unknown> }>> {
  const seen: Array<{ msg: string; data?: Record<string, unknown> }> = [];
  const original = logger.warn;
  logger.warn = (msg, data) => { seen.push({ msg, data }); };
  try { await run(); } finally { logger.warn = original; }
  return seen;
}

test("Claude: no continuation once the search budget is spent; the brief is marked and a warning logged", async () => {
  const seen: ClaudeRequest[] = [];
  let brief!: Awaited<ReturnType<typeof runResearch>>;
  const warnings = await warningsOf(async () => {
    brief = await runResearch("s", "u", claudeChoice, { maxSearches: 2, client: fakeClaude([message([serverUse(), textBlock("Notite.", [cite(A, "t", "q")])], "pause_turn", 2)], seen) });
  });
  assert.equal(seen.length, 1);
  assert.equal(brief.calls, 1);
  assert.equal(brief.searches, 2);
  assert.equal(brief.text, `Notite.[S1]\n\n${STOPPED_EARLY_NOTE}`);
  assert.ok(warnings.some((w) => /stopped early/.test(w.msg) && w.data?.searches === 2 && w.data?.maxSearches === 2));
});

test("Claude: a finished turn is not marked", async () => {
  let brief!: Awaited<ReturnType<typeof runResearch>>;
  const warnings = await warningsOf(async () => {
    brief = await runResearch("s", "u", claudeChoice, { client: fakeClaude([message([textBlock("Notite.", [cite(A, "t", "q")])], "end_turn", 1)]) });
  });
  assert.equal(brief.text, "Notite.[S1]");
  assert.deepEqual(warnings, []);
});

test("Claude: a paused turn that never wrote notes is a bad output; other stops map like the writer", async () => {
  await assert.rejects(runResearch("s", "u", claudeChoice, { maxSearches: 1, client: fakeClaude([message([serverUse()], "pause_turn", 1)]) }), { code: "AI_BAD_OUTPUT" });
  await assert.rejects(runResearch("s", "u", claudeChoice, { client: fakeClaude([message([textBlock("   ")])]) }), { code: "AI_BAD_OUTPUT" });
  for (const [stop, code] of [["refusal", "AI_REFUSED"], ["max_tokens", "AI_TRUNCATED"], ["tool_use", "AI_BAD_OUTPUT"]] as const) {
    await assert.rejects(runResearch("s", "u", claudeChoice, { client: fakeClaude([message([textBlock("x")], stop)]) }), { code });
  }
});

test("a lost lease aborts the research call; the research time limit says so", async () => {
  const hang: ClaudeClient = { beta: { messages: { stream: (_params, options) => ({
    finalMessage: () => new Promise<never>((_, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal!.reason))),
  }) } } };
  // AbortSignal.timeout does not hold the event loop open (a real HTTP request would), so this does.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(runResearch("s", "u", claudeChoice, { client: hang, timeoutMs: 20 }), /Research timed out after 20 ms/);
    const lease = new AbortController();
    setTimeout(() => lease.abort(new Error("LEASE_LOST")), 10);
    await assert.rejects(runResearch("s", "u", claudeChoice, { client: hang, signal: lease.signal, timeoutMs: 5000 }), /LEASE_LOST/);
  } finally { clearInterval(keepAlive); }
});

// --- Gemini ---
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const REDIRECT = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/";
const sentence1 = "Dobânda a crescut la 6%.";
const sentence2 = " Ministerul a confirmat.";
const answer = sentence1 + sentence2;
function groundedBody(extra: Record<string, unknown> = {}) {
  return { candidates: [{ finishReason: "STOP", content: { parts: [{ text: answer }] }, groundingMetadata: {
    webSearchQueries: ["dobanda 2026", "ministerul finantelor"],
    groundingChunks: [
      { web: { uri: `${REDIRECT}AAA`, title: "reuters.com" } },
      { web: { uri: `${REDIRECT}BBB`, title: "Banca a anuntat o crestere" } },
      { web: { uri: `${REDIRECT}CCC`, title: "profit.ro" } },
      { web: { uri: "https://www.bnr.ro/comunicat", title: "bnr.ro" } },
      { web: { uri: `${REDIRECT}DDD`, title: "www.reuters.com" } },
    ],
    groundingSupports: [
      // Offsets are UTF-8 bytes ("â" is two), and the supports arrive out of text order.
      { segment: { startIndex: bytes(sentence1), endIndex: bytes(answer), text: sentence2.trim() }, groundingChunkIndices: [0, 4] },
      { segment: { startIndex: 0, endIndex: bytes(sentence1), text: sentence1 }, groundingChunkIndices: [1] },
    ],
  } }], ...extra };
}
function geminiFetch(apiBody: unknown, redirects: Record<string, string | Error>, calls: Array<{ url: string; init?: RequestInit }> = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("https://generativelanguage.googleapis.com/")) return Response.json(apiBody);
    const target = redirects[url];
    if (target instanceof Error) throw target;
    return target ? new Response(null, { status: 302, headers: { location: target } }) : new Response("ok", { status: 200 });
  }) as typeof fetch;
}

test("Gemini: grounding becomes sources and [S#] markers; redirects are resolved without following them", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = geminiFetch(groundedBody(), {
    [`${REDIRECT}AAA`]: "https://www.reuters.com/markets/a",
    [`${REDIRECT}BBB`]: "https://example.org/b?utm=1",
    [`${REDIRECT}CCC`]: new Error("network down"),
    [`${REDIRECT}DDD`]: "https://www.reuters.com/markets/a",
  }, calls);
  const brief = await runResearch("system", "user", geminiChoice, { fetch: fetchFn });
  // Cited in text order (BBB, then AAA; DDD is the same page as AAA), then the uncited ones.
  assert.deepEqual(brief.sources.map((s) => [s.id, s.url]), [
    ["S1", "https://example.org/b?utm=1"],
    ["S2", "https://www.reuters.com/markets/a"],
    ["S3", `${REDIRECT}CCC`],
    ["S4", "https://www.bnr.ro/comunicat"],
  ]);
  assert.equal(brief.text, `${sentence1}[S1]${sentence2}[S2]`);
  assert.equal(brief.searches, 2);
  assert.equal(brief.calls, 1);
  assert.equal(brief.provider, "gemini");
  assert.equal(brief.model, "gemini-3.8-flash");
  // The title is the publisher when it looks like a domain.
  assert.equal(brief.sources[1]!.publisher, "reuters.com");
  assert.equal(brief.sources[2]!.publisher, "profit.ro");
  assert.equal(brief.sources[3]!.publisher, "bnr.ro");
  assert.equal(brief.sources[0]!.title, "Banca a anuntat o crestere");
  assert.equal(brief.sources[0]!.cited_text, sentence1);
  assert.equal(brief.sources[2]!.cited_text, "");
  // The API call: google_search, no schema or JSON mime type.
  const api = calls.find((c) => c.url.includes("generativelanguage"))!;
  const body = JSON.parse(String(api.init?.body));
  assert.deepEqual(body.tools, [{ google_search: {} }]);
  assert.equal(body.generationConfig.responseMimeType, undefined);
  assert.equal(body.generationConfig.responseJsonSchema, undefined);
  assert.match(body.systemInstruction.parts[0].text, /at most 5 web searches/);
  // Each redirect was looked up once, manually and with a time limit; the plain URL was not fetched.
  const lookups = calls.filter((c) => c.url.startsWith(REDIRECT));
  assert.deepEqual(lookups.map((c) => c.url).sort(), [`${REDIRECT}AAA`, `${REDIRECT}BBB`, `${REDIRECT}CCC`, `${REDIRECT}DDD`]);
  for (const lookup of lookups) {
    assert.equal(lookup.init?.redirect, "manual");
    assert.ok(lookup.init?.signal instanceof AbortSignal);
  }
  assert.ok(!calls.some((c) => c.url.includes("bnr.ro")));
});

test("Gemini: a redirect that answers without a location keeps the redirect URL; no grounding means no sources", async () => {
  const body = groundedBody();
  const fetchFn = geminiFetch(body, {});
  const brief = await runResearch("s", "u", geminiChoice, { fetch: fetchFn });
  assert.ok(brief.sources.some((s) => s.url === `${REDIRECT}AAA`));
  const plain = await runResearch("s", "u", geminiChoice, { fetch: geminiFetch({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Fara surse." }] } }] }, {}) });
  assert.deepEqual(plain.sources, []);
  assert.equal(plain.text, "Fara surse.");
  assert.equal(plain.searches, 0);
});

test("Gemini: stop reasons and missing text fail like the writer", async () => {
  const reply = (finishReason: string, parts: unknown[] = [{ text: "x" }]) => geminiFetch({ candidates: [{ finishReason, content: { parts } }] }, {});
  await assert.rejects(runResearch("s", "u", geminiChoice, { fetch: reply("SAFETY") }), { code: "AI_REFUSED" });
  await assert.rejects(runResearch("s", "u", geminiChoice, { fetch: reply("MAX_TOKENS") }), { code: "AI_TRUNCATED" });
  await assert.rejects(runResearch("s", "u", geminiChoice, { fetch: reply("STOP", []) }), { code: "AI_BAD_OUTPUT" });
  await assert.rejects(runResearch("s", "u", geminiChoice, { fetch: (async () => Response.json({ error: { message: "bad" } }, { status: 400 })) as typeof fetch }), /Gemini API 400/);
});

const GEMINI_API = "https://generativelanguage.googleapis.com/";

test("Gemini: calls counts every HTTP attempt, retries included", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    if (!String(input).startsWith(GEMINI_API)) return new Response("ok");
    attempts++;
    return attempts < 3 ? Response.json({ error: { message: "busy" } }, { status: 503 }) : Response.json(groundedBody());
  }) as typeof fetch;
  const brief = await runResearch("s", "u", geminiChoice, { fetch: fetchFn, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [5000, 15000]);
  assert.equal(brief.calls, 3);
  assert.equal(brief.searches, 2);
});

test("Gemini: more searches than RESEARCH_MAX_SEARCHES is logged (the brief is still used)", async () => {
  let brief!: Awaited<ReturnType<typeof runResearch>>;
  const over = await warningsOf(async () => { brief = await runResearch("s", "u", geminiChoice, { maxSearches: 1, fetch: geminiFetch(groundedBody(), {}) }); });
  assert.deepEqual(over.map((w) => [w.msg, w.data]), [["Gemini grounding used more searches than allowed", { searches: 2, maxSearches: 1 }]]);
  assert.equal(brief.searches, 2);
  assert.ok(brief.sources.length > 0);
  assert.deepEqual(await warningsOf(() => runResearch("s", "u", geminiChoice, { maxSearches: 2, fetch: geminiFetch(groundedBody(), {}) })), []);
});

test("Gemini: an abort or timeout while the body is read is rethrown, not read as an empty answer", async () => {
  const brokenBody = (read: () => Promise<never>) => (async () => ({ ok: true, status: 200, statusText: "OK", json: read })) as unknown as typeof fetch;
  for (const name of ["AbortError", "TimeoutError"]) {
    await assert.rejects(runResearch("s", "u", geminiChoice, { fetch: brokenBody(async () => { throw new DOMException("read cut off", name); }) }), { name });
  }
  // The lease was lost while the body came in: whatever the read threw, the caller sees the abort.
  const lease = new AbortController();
  await assert.rejects(runResearch("s", "u", geminiChoice, {
    signal: lease.signal,
    fetch: brokenBody(async () => { lease.abort(new Error("LEASE_LOST")); throw lease.signal.reason; }),
  }), /LEASE_LOST/);
  // A body that is not JSON still reads as empty, and the missing answer is the error.
  await assert.rejects(runResearch("s", "u", geminiChoice, { fetch: (async () => new Response("<html>busy</html>", { status: 200 })) as typeof fetch }), { code: "AI_BAD_OUTPUT" });
  await assert.rejects(runResearch("s", "u", geminiChoice, { fetch: (async () => new Response("<html>", { status: 502 })) as typeof fetch, sleep: async () => {} }), /Gemini API 502/);
});

// --- the verdict in the notes ---

test("researchVerdict: news stops on a verdict line, narration before it included, unless a story block is there", () => {
  const verdict = (text: string, type = "news") => researchVerdict(text, type);
  assert.equal(verdict("NO QUALIFYING STORY\nnear miss | 6 | one source"), "no_story");
  assert.equal(verdict("I ran five searches and read the results.\n\nNo qualifying story\nnear miss"), "no_story");
  assert.equal(verdict("Searches done.\r\n**NO QUALIFYING STORY**"), "no_story");
  assert.equal(verdict("> - no qualifying story"), "no_story");
  assert.equal(verdict("Nothing.\nNO SOURCES FOUND"), "no_sources");
  // NO QUALIFYING STORY wins when both are said.
  assert.equal(verdict("NO SOURCES FOUND\nNO QUALIFYING STORY"), "no_story");
  // A story block: the verdict words are narration.
  assert.equal(verdict("STORY 1: BNR raises the rate\nFacts:\n- 6%.[S1]\nNO QUALIFYING STORY for the rest"), "ok");
  assert.equal(verdict("Story 2: x\nno sources found for the second"), "ok");
  // Inside a sentence is not the start of a line.
  assert.equal(verdict("Result: NO QUALIFYING STORY"), "ok");
  assert.equal(verdict("The audit said no qualifying story was found, so I list one."), "ok");
  assert.equal(verdict("Plain notes."), "ok");
});

test("researchVerdict: topic and article research stop only on NO SOURCES FOUND without a story or a facts list", () => {
  for (const type of ["topic", "article", undefined]) {
    assert.equal(researchVerdict("NO QUALIFYING STORY\nnear miss", type), "ok");
    assert.equal(researchVerdict("I searched.\nNO SOURCES FOUND", type), "no_sources");
    assert.equal(researchVerdict("**No sources found**\nUnverified: none", type), "no_sources");
    assert.equal(researchVerdict("NO SOURCES FOUND for the news.\nFacts:\n- The rate is 6%.[S1]", type), "ok");
    assert.equal(researchVerdict("NO SOURCES FOUND\nFacts: none", type), "no_sources");
    assert.equal(researchVerdict("NO SOURCES FOUND\nSTORY 1: x", type), "ok");
    assert.equal(researchVerdict("NO SOURCES FOUND for the first query\nANGLE 1: New rule\nDate: none", type), "ok");
    assert.equal(researchVerdict("They said NO SOURCES FOUND here", type), "ok");
  }
});

test("wantsResearch: asked for, or a news source", () => {
  assert.equal(wantsResearch({ research: true, source: { type: "topic" } }), true);
  assert.equal(wantsResearch({ source: { type: "news" } }), true);
  assert.equal(wantsResearch({ research: false, source: { type: "article" } }), false);
  assert.equal(wantsResearch({}), false);
  assert.equal(wantsResearch(undefined), false);
});
