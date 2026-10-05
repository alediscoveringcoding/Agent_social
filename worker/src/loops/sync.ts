import { config } from "../config.js";
import { logger } from "../logger.js";
import { siteApi } from "../services/site-api.js";
import { postizApi } from "../services/postiz-api.js";

export function startSyncLoop() {
  if (config.WORKER_DRY_RUN) {
    logger.info("DRY RUN: account sync skipped; use the local fake worker to sync accounts");
    return;
  }
  async function tick() {
    try {
      const integrations = await postizApi.listIntegrations();
      if (!integrations || !Array.isArray(integrations)) return;

      // Last 24h, for foreign-post detection
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      let recentPosts: any[] = [];
      try {
        recentPosts = await postizApi.listPosts(yesterday);
        if (!Array.isArray(recentPosts)) recentPosts = [];
      } catch {
        recentPosts = [];
      }

      const payload = {
        integrations: integrations.map((i: any) => ({
          postiz_integration_id: i.id,
          provider: i.providerIdentifier || i.provider || i.type,
          name: i.name || i.displayName,
          picture_url: i.picture || i.profilePicture || null,
          profile_url: i.profileUrl || null,
          disabled: i.disabled || false,
          refresh_needed: i.refreshNeeded || i.tokenExpired || false,
          rules: i.settings || {},
        })),
        postiz_recent_posts: recentPosts.map((p: any) => ({
          postiz_post_id: p.id,
          integration_id: p.integration || p.integrationId,
          created_at: p.createdAt || p.created_at,
        })),
      };

      await siteApi.syncAccounts(payload);
      logger.info("Account sync complete", { count: integrations.length });
    } catch (err) {
      logger.error("Sync loop error", { error: String(err) });
    }
  }

  setInterval(tick, config.SYNC_LOOP_INTERVAL_MS);
  // Run first sync after 5 seconds
  setTimeout(tick, 5000);
}
