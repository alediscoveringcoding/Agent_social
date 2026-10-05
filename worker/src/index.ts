import { config } from "./config.js";
import { logger } from "./logger.js";
import { startDeliveryLoop } from "./loops/delivery.js";
import { startGeneratorLoop } from "./loops/generator.js";
import { startSyncLoop } from "./loops/sync.js";
import { availableProviders, generatorProvider } from "./services/llm.js";
import { startHealthServer } from "./utils/health.js";

async function main() {
  logger.info("Worker starting", {
    workerId: config.WORKER_ID,
    dryRun: config.WORKER_DRY_RUN,
    siteBase: config.SITE_BASE_URL,
    postizBase: config.POSTIZ_BASE_URL,
  });

  startDeliveryLoop();
  startSyncLoop();
  startHealthServer();

  // The loop runs when any AI key is set: the admin picks the model per request,
  // and a pick without its key fails that request with AI_NOT_CONFIGURED.
  const available = availableProviders();
  if (available.length > 0) {
    const fallback = generatorProvider();
    logger.info("Generator loop enabled", {
      available,
      defaultProvider: fallback,
      defaultModel: fallback === "gemini" ? config.GEMINI_MODEL : config.GENERATOR_MODEL,
    });
    if (fallback && !available.includes(fallback)) {
      logger.warn(`GENERATOR_PROVIDER=${fallback} has no API key: requests without a model pick will fail`);
    }
    startGeneratorLoop();
  } else {
    logger.warn("No ANTHROPIC_API_KEY or GEMINI_API_KEY set, generator loop disabled (delivery + sync still run)");
  }

  logger.info("All loops running");
}

main().catch((err) => {
  logger.error("Fatal error", { error: String(err) });
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", () => {
  logger.info("Shutting down");
  process.exit(0);
});
process.on("SIGTERM", () => {
  logger.info("Shutting down");
  process.exit(0);
});
