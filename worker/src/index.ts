import { config } from "./config.js";
import { logger } from "./logger.js";
import { startDeliveryLoop } from "./loops/delivery.js";
import { startGeneratorLoop } from "./loops/generator.js";
import { startSyncLoop } from "./loops/sync.js";
import { generatorProvider } from "./services/llm.js";
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

  const provider = generatorProvider();
  const hasKey =
    provider === "claude" ? !!config.ANTHROPIC_API_KEY : !!config.GEMINI_API_KEY;
  if (provider && hasKey) {
    logger.info("Generator loop enabled", {
      provider,
      model: provider === "gemini" ? config.GEMINI_MODEL : config.GENERATOR_MODEL,
    });
    startGeneratorLoop();
  } else {
    logger.warn(
      provider
        ? `GENERATOR_PROVIDER=${provider} but its API key is not set, generator loop disabled`
        : "No ANTHROPIC_API_KEY or GEMINI_API_KEY set, generator loop disabled (delivery + sync still run)",
    );
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
