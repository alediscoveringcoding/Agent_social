import { config } from "../config.js";
import { logger } from "../logger.js";
import { siteApi } from "../services/site-api.js";
import { postizApi } from "../services/postiz-api.js";
import { platformForProvider } from "../platforms.js";

/**
 * One Postiz channel as the site's /accounts/sync wants it. GET /public/v1/integrations
 * names the provider `identifier` (v2.25.0); `providerIdentifier` is what the database
 * column and older mocks call it. The site maps the identifier to its platform
 * (PROVIDER_TO_PLATFORM in site/src/lib/social/constants.ts, which this worker's
 * platforms.ts mirrors) and ignores providers it does not know.
 */
export function mapIntegration(i: any) {
  return {
    postiz_integration_id: i.id,
    provider: i.identifier || i.providerIdentifier || i.provider || i.type,
    name: i.name || i.displayName,
    picture_url: i.picture || i.profilePicture || null,
    profile_url: i.profileUrl || null,
    disabled: i.disabled || false,
    refresh_needed: i.refreshNeeded || i.tokenExpired || false,
    rules: i.settings || {},
  };
}

/** A recent Postiz post; GET /posts lists the channel as `integration: {id}`. */
export function mapRecentPost(p: any) {
  return {
    postiz_post_id: p.id,
    integration_id: p.integration?.id ?? p.integration ?? p.integrationId,
    created_at: p.createdAt || p.created_at || p.publishDate,
  };
}

export function buildSyncPayload(integrations: any[], recentPosts: any[]) {
  const mapped = integrations.map(mapIntegration);
  for (const m of mapped) {
    if (!platformForProvider(m.provider)) {
      logger.warn("Postiz channel with a provider this app does not publish to; the site will ignore it", { provider: m.provider, name: m.name });
    }
  }
  return { integrations: mapped, postiz_recent_posts: recentPosts.map(mapRecentPost) };
}

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

      await siteApi.syncAccounts(buildSyncPayload(integrations, recentPosts));
      logger.info("Account sync complete", { count: integrations.length });
    } catch (err) {
      logger.error("Sync loop error", { error: String(err) });
    }
  }

  setInterval(tick, config.SYNC_LOOP_INTERVAL_MS);
  // Run first sync after 5 seconds
  setTimeout(tick, 5000);
}
