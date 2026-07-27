import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "../../../middleware/requireAuth";
import { codingStreakService } from "../service/codingStreak.service";
import { env } from "../../../config/env";

const router = Router();

// GET /api/dashboard/coding-streak
// Cross-org, same reasoning as /home — a developer's streak isn't scoped
// to a single organization.
router.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const detail = await codingStreakService.getDetail(req.userId!, env.backendBaseUrl);
  res.json(detail);
});

const goalsSchema = z.object({
  weeklyCommitGoal: z.number().int().min(1).max(500).optional(),
  weeklyIssueGoal: z.number().int().min(1).max(200).optional(),
});

// PATCH /api/dashboard/coding-streak/goals
router.patch("/goals", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = goalsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const updated = await codingStreakService.updateGoals(
    req.userId!,
    parsed.data.weeklyCommitGoal,
    parsed.data.weeklyIssueGoal,
  );
  res.json(updated);
});

const focusSessionSchema = z.object({
  minutes: z.number().int().min(1).max(24 * 60),
  note: z.string().max(300).optional(),
});

// POST /api/dashboard/coding-streak/focus-session
// Self-reported by design — see FocusSession model comment in schema.prisma.
router.post("/focus-session", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = focusSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const session = await codingStreakService.logFocusSession(
    req.userId!,
    parsed.data.minutes,
    parsed.data.note,
  );
  res.status(201).json(session);
});

// POST /api/dashboard/coding-streak/webhook/rotate
// Invalidates the old webhook URL immediately (old token stops matching
// any user) — same rotate-without-losing-history pattern as
// BuildPipeline's rotate-webhook endpoint.
router.post("/webhook/rotate", requireAuth, async (req: AuthedRequest, res) => {
  const token = await codingStreakService.rotateWebhookToken(req.userId!);
  const webhookUrl = env.backendBaseUrl
    ? `${env.backendBaseUrl.replace(/\/$/, "")}/api/webhooks/git/${token}`
    : null;
  res.json({ webhookUrl });
});

// GET /api/dashboard/coding-streak/leaderboard?organizationId=...
// The one coding-streak endpoint that IS org-scoped — a leaderboard only
// makes sense relative to a specific team, and access is gated on actual
// membership inside the service (never trusts the query param alone).
router.get("/leaderboard", requireAuth, async (req: AuthedRequest, res) => {
  const organizationId = String(req.query.organizationId || "");
  if (!organizationId) {
    return res.status(400).json({ error: "organizationId is required" });
  }
  try {
    const entries = await codingStreakService.getLeaderboard(req.userId!, organizationId);
    res.json({ entries });
  } catch (err) {
    res.status(403).json({ error: (err as Error).message });
  }
});

// POST /api/dashboard/coding-streak/maintenance/run
// Cron-secret protected, not user-session protected — identical shape to
// digest.routes.ts's /run endpoint. Meant to be hit once a day, shortly
// after midnight UTC, by whatever scheduler already triggers the digest.
router.post("/maintenance/run", async (req, res) => {
  if (!env.digestCronSecret || req.headers["x-cron-secret"] !== env.digestCronSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const result = await codingStreakService.runFreezeMaintenance();
  res.json(result);
});

export default router;
