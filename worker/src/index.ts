import { config } from "./config.js";
import { logger } from "./logger.js";
import { startDeliveryLoop } from "./loops/delivery.js";
import { startGeneratorLoop } from "./loops/generator.js";
import { startSyncLoop } from "./loops/sync.js";
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

  if (config.ANTHROPIC_API_KEY) {
    startGeneratorLoop();
  } else {
    logger.warn("ANTHROPIC_API_KEY not set, generator loop disabled (delivery + sync still run)");
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
