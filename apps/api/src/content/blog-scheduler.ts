/**
 * Smart Publishing Scheduler & State Machine Worker for AI Blog & Promotion Campaigns.
 *
 * State transitions:
 *   draft -> ai_reviewed -> scheduled -> published (or failed_retry up to 3 attempts)
 *
 * Uses atomic database claim RPC `velura_publish_scheduled_blogs` (`FOR UPDATE SKIP LOCKED`)
 * so multiple K3s API pods never double-publish or double-broadcast newsletters.
 */

import { config } from "../config.js";
import { newsletterService } from "../newsletter/newsletter-service.js";
import { callRpc, updateRows } from "../supabase.js";
import { asJsonObject, asString, errorMessage, type JsonObject } from "../types.js";

const DEFAULT_BLOG_SCHEDULER_INTERVAL_MS = 60_000;

export interface ScheduledBlogPublishSummary {
  readonly publishedCount: number;
  readonly publishedIds: readonly string[];
  readonly failedRetryIds: readonly string[];
  readonly broadcastErrors: number;
}

/**
 * Claims and publishes all due `scheduled` / `failed_retry` (`publish_attempts < 3`) blog posts,
 * synchronizing promotion schedules and triggering idempotent newsletter broadcasts.
 * Transitions any post whose downstream broadcast fails into `failed_retry` so retries occur up to `publish_attempts = 3`.
 */
export async function runScheduledBlogPublishCycle(
  deps: {
    claimDueBlogs?: (limit: number) => Promise<JsonObject[]>;
    broadcastBlog?: (payload: Parameters<typeof newsletterService.broadcastBlog>[0]) => Promise<{ queuedCount: number }>;
    recordBroadcastError?: (blogId: string, errText: string) => Promise<void>;
  } = {},
): Promise<ScheduledBlogPublishSummary> {
  const claim =
    deps.claimDueBlogs ??
    (async (limit: number) => {
      const res = await callRpc("velura_publish_scheduled_blogs", { p_limit: limit }, { useAnonKey: false });
      return Array.isArray(res) ? res.map(asJsonObject) : [];
    });
  const broadcast = deps.broadcastBlog ?? ((payload) => newsletterService.broadcastBlog(payload));
  const recordErr =
    deps.recordBroadcastError ??
    (async (blogId: string, errText: string) => {
      await updateRows(
        "blog",
        { blog_id: `eq.${blogId}` },
        { status: "failed_retry", last_publish_error: errText.slice(0, 500) },
      ).catch(() => undefined);
    });

  let rows: JsonObject[] = [];
  try {
    rows = await claim(10);
  } catch (err: unknown) {
    const msg = errorMessage(err);
    // Quietly tolerate pre-migration rolling deploy before migration 134 is applied
    if (!/velura_publish_scheduled_blogs|does not exist|PGRST202/i.test(msg)) {
      console.error("[blog-scheduler] claim cycle failed:", msg);
    }
    return { publishedCount: 0, publishedIds: [], failedRetryIds: [], broadcastErrors: 0 };
  }

  const publishedIds: string[] = [];
  const failedRetryIds: string[] = [];
  let broadcastErrors = 0;

  for (const row of rows) {
    const blogId = asString(row.blog_id);
    if (!blogId) continue;

    if (!row.newsletter_broadcast_at) {
      try {
        await broadcast({
          blogId,
          slug: asString(row.slug),
          title: asString(row.title),
          excerpt: asString(row.excerpt),
          imageUrl: asString(row.image_url),
          author: asString(row.author) || "Velura Editorial",
        });
        publishedIds.push(blogId);
      } catch (err: unknown) {
        broadcastErrors++;
        failedRetryIds.push(blogId);
        await recordErr(blogId, errorMessage(err));
      }
    } else {
      publishedIds.push(blogId);
    }
  }

  return {
    publishedCount: publishedIds.length,
    publishedIds,
    failedRetryIds,
    broadcastErrors,
  };
}

/**
 * Starts the periodic Smart Blog Publishing Scheduler in the API process.
 */
export function startBlogScheduler(): ReturnType<typeof setInterval> | null {
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? config.supabaseServiceRoleKey ?? "").trim();
  if (!serviceKey) return null;
  const intervalMs =
    Number(process.env.BLOG_SCHEDULER_INTERVAL_MS || config.blogSchedulerIntervalMs) || DEFAULT_BLOG_SCHEDULER_INTERVAL_MS;
  if (intervalMs <= 0) return null;

  const tick = () => {
    void runScheduledBlogPublishCycle();
  };

  // Initial check shortly after server boot
  const bootTimer = setTimeout(tick, 3500);
  bootTimer.unref?.();

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}
