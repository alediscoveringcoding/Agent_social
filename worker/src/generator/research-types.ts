// Research step contract (amendment 07): what the web-search call hands to the writer.

/** One page the search actually returned. `id` is how the writer cites it ("S1"). */
export interface ResearchSource {
  id: string;
  url: string;
  title: string;
  /** Site or outlet name; "" when unknown. */
  publisher: string;
  /** Date as the search reported it (page age); "" when unknown. */
  published_at: string;
  /** A short quote the research notes cited from it; "" when none. */
  cited_text: string;
}

export interface ResearchBrief {
  /** Research notes with [S1] markers after the facts each source supports. */
  text: string;
  sources: ResearchSource[];
  /** Web searches billed for this brief. */
  searches: number;
  provider: "claude" | "gemini";
  model: string;
}

/** A request researches when it asks to, or when its source is recent news. */
export function wantsResearch(input: { research?: boolean; source?: { type?: string } } | null | undefined): boolean {
  return Boolean(input?.research) || input?.source?.type === "news";
}
