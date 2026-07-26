import crypto from "crypto";
import { prisma } from "../../../../lib/prisma";
import { AISummaryDto } from "../../dto/dashboard.dto";
import { env } from "../../../../config/env";

export interface CacheableSummaryInput {
  [key: string]: unknown;
}

/**
 * Thin persistence layer around the AISummaryCache table. Two independent
 * freshness checks, both must pass for a cache hit:
 *   1. contextHash matches (the user's actual data hasn't changed since
 *      the summary was generated — e.g. no new assignment, no new
 *      notification)
 *   2. generatedAt is within env.aiSummaryCacheTtlMinutes (belt-and-
 *      suspenders cap on staleness, in case the hash ever misses an input)
 *
 * This exists mainly to control LLM spend: without it, every dashboard
 * load (every page refresh) would trigger a fresh Anthropic API call.
 */
export class AISummaryCacheStore {
  static hashContext(input: CacheableSummaryInput): string {
    const json = JSON.stringify(input, Object.keys(input).sort());
    return crypto.createHash("sha256").update(json).digest("hex");
  }

  async get(userId: string, contextHash: string): Promise<AISummaryDto | null> {
    const row = await prisma.aISummaryCache.findUnique({ where: { userId } });
    if (!row) return null;
    if (row.contextHash !== contextHash) return null;

    const ageMinutes = (Date.now() - row.generatedAt.getTime()) / 60_000;
    if (ageMinutes > env.aiSummaryCacheTtlMinutes) return null;

    return {
      headline: row.headline,
      bullets: row.bullets as string[],
      generatedAt: row.generatedAt.toISOString(),
    };
  }

  async set(
    userId: string,
    contextHash: string,
    summary: AISummaryDto,
    model: string,
  ): Promise<void> {
    await prisma.aISummaryCache.upsert({
      where: { userId },
      create: {
        userId,
        headline: summary.headline,
        bullets: summary.bullets,
        contextHash,
        model,
        generatedAt: new Date(summary.generatedAt),
      },
      update: {
        headline: summary.headline,
        bullets: summary.bullets,
        contextHash,
        model,
        generatedAt: new Date(summary.generatedAt),
      },
    });
  }
}
