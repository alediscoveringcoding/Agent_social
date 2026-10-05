import { config } from "../config.js";
import { logger } from "../logger.js";
import { siteApi } from "../services/site-api.js";
import { generateDrafts } from "../services/llm.js";
import { validateContent, extractFigures } from "../generator/validators.js";
import { buildSystemPrompt, buildUserPrompt, brandFromSlug } from "../generator/prompts.js";
import { buildRepairPrompt } from "../generator/repair.js";

export function startGeneratorLoop() {
  async function tick() {
    try {
      const { requests } = await siteApi.claimGeneration();
      if (!requests || requests.length === 0) return;

      for (const req of requests) {
        await processGenerationRequest(req);
      }
    } catch (err) {
      logger.error("Generator loop error", { error: String(err) });
    }
  }

  setInterval(tick, config.GENERATION_LOOP_INTERVAL_MS);
  tick();
}

function validateDraft(draft: any, i: number) {
  const errors: any[] = [];

  const canonicalErrors = validateContent(draft.canonical_text || "", "generic");
  errors.push(...canonicalErrors.filter((e) => e.rule !== "contains_figures"));

  for (const variant of draft.variants || []) {
    const variantErrors = validateContent(variant.text, variant.platform);
    errors.push(...variantErrors.map((e) => ({ ...e, field: `variants.${variant.platform}` })));
  }

  const allText = [draft.canonical_text, ...(draft.variants || []).map((v: any) => v.text)].join(
    " ",
  );
  const figures = extractFigures(allText);

  return {
    ...draft,
    client_ref: draft.client_ref || String(i + 1),
    figures: figures.length > 0 ? figures : draft.figures || [],
    validation_errors: errors,
  };
}

async function processGenerationRequest(req: any) {
  // The worker API sends `brand` as a plain slug string (worker-api.openapi.yaml
  // GenerationRequest), not an {slug, name} object.
  const { request_id, brand: brandSlug, input } = req;
  const brand = brandFromSlug(brandSlug);
  logger.info("Processing generation request", { requestId: request_id, brand: brand.slug });

  try {
    const systemPrompt = buildSystemPrompt(brand, input);
    const userPrompt = buildUserPrompt(input);

    const { drafts, stopReason } = await generateDrafts(systemPrompt, userPrompt);
    logger.info("Generated drafts", { requestId: request_id, count: drafts.length, stopReason });

    const validatedDrafts = drafts.map((draft: any, i: number) => validateDraft(draft, i));

    // One automatic repair attempt if anything other than "contains_figures" failed.
    const needsRepair = validatedDrafts.some(
      (d: any) =>
        d.validation_errors.length > 0 &&
        !d.validation_errors.every((e: any) => e.rule === "contains_figures"),
    );

    let finalDrafts = validatedDrafts;
    if (needsRepair) {
      logger.info("Attempting repair pass", { requestId: request_id });
      try {
        const repairPrompt = buildRepairPrompt(validatedDrafts);
        const { drafts: repairedDrafts } = await generateDrafts(
          buildSystemPrompt(brand, input),
          repairPrompt,
        );
        finalDrafts = repairedDrafts.map((draft: any, i: number) => validateDraft(draft, i));
      } catch (repairErr) {
        logger.warn("Repair pass failed, using original", { error: String(repairErr) });
      }
    }

    const result = await siteApi.postDrafts(request_id, finalDrafts);
    logger.info("Drafts posted", {
      requestId: request_id,
      created: result.created,
      skipped: result.skipped,
    });
  } catch (err) {
    logger.error("Generation failed", { requestId: request_id, error: String(err) });
    await siteApi.generationFailed(request_id, "GENERATION_ERROR", String(err));
  }
}
