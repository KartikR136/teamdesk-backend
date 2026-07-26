import { Router } from "express";
import { prisma } from "../../../lib/prisma";
import { env } from "../../../config/env";
import { dashboardService } from "./dashboard.routes";

const router = Router();

/**
 * POST /api/dashboard/digest/run
 *
 * Generates today's AI summary for every user who has at least one
 * organization membership, and posts each one to DIGEST_WEBHOOK_URL
 * (a Slack incoming webhook, or any endpoint accepting { text }).
 *
 * This is meant to be hit by a scheduler (cron, GitHub Actions schedule,
 * Vercel Cron, etc.) once a day — not by the frontend. It's guarded by a
 * shared secret rather than a user session because there's no logged-in
 * user driving it.
 *
 * No-ops (204) if DIGEST_WEBHOOK_URL isn't configured, so this is safe to
 * leave wired up even in environments that haven't set it up yet.
 */
router.post("/run", async (req, res) => {
  if (!env.digestCronSecret || req.headers["x-cron-secret"] !== env.digestCronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!env.digestWebhookUrl) {
    return res.status(204).end();
  }

  const users = await prisma.user.findMany({
    where: { memberships: { some: {} } },
    select: { id: true, name: true },
  });

  const results: { userId: string; ok: boolean }[] = [];

  for (const user of users) {
    try {
      const home = await dashboardService.getHome(user.id);
      const lines = [
        `*${home.aiSummary.headline}* — for ${user.name}`,
        ...home.aiSummary.bullets.map((b) => `• ${b}`),
      ];

      const webhookRes = await fetch(env.digestWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: lines.join("\n") }),
      });

      results.push({ userId: user.id, ok: webhookRes.ok });
    } catch (err) {
      console.error(`[digest] failed for user ${user.id}:`, err);
      results.push({ userId: user.id, ok: false });
    }
  }

  res.json({ sent: results.filter((r) => r.ok).length, total: results.length, results });
});

export default router;
