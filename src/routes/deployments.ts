import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole, OrgScopedRequest } from "../middleware/requireRole";
import {
  resolveOrgFromParam,
  resolveOrgFromDeployment,
} from "../lib/resolveOrgContext";
import {
  paginationQuerySchema,
  buildPaginationArgs,
  paginateResults,
} from "../lib/pagination";
import { logActivity, ActivityAction } from "../lib/activityLog";
import { notify, notifyMany, NotificationType } from "../lib/notifications";

const router = Router();
router.use(requireAuth);

const ENVIRONMENTS = [
  "PRODUCTION",
  "PREVIEW",
  "STAGING",
  "DEVELOPMENT",
] as const;
const STATUSES = [
  "QUEUED",
  "IN_PROGRESS",
  "SUCCESS",
  "FAILED",
  "ROLLED_BACK",
] as const;
const HEALTHS = ["UNKNOWN", "HEALTHY", "DEGRADED", "UNHEALTHY"] as const;

// Shared response shape for a single deployment — the list, detail, and
// every mutation response all need the same joined data, same convention
// as pullRequests.ts's prInclude().
function deploymentInclude() {
  return {
    triggeredBy: { select: { id: true, name: true, email: true } },
    rolledBackBy: { select: { id: true, name: true } },
    project: { select: { id: true, name: true } },
    pullRequest: {
      select: { id: true, title: true, mergedAt: true, repoName: true },
    },
    previousDeployment: {
      select: {
        id: true,
        commitHash: true,
        environment: true,
        createdAt: true,
      },
    },
    rollbacks: {
      select: { id: true, commitHash: true, createdAt: true, status: true },
    },
  };
}

// Deterministic "did this deploy succeed" outcome derived from the commit
// hash rather than Math.random() — makes the demo reproducible (the same
// commitHash always resolves the same way) while still feeling like a
// real CI pipeline instead of always succeeding. Production is held to a
// slightly higher bar than preview/dev, mirroring how real pipelines tend
// to have stricter production gates (approvals, smoke tests) that catch
// more failures before they ship.
function hashToUnitInterval(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0) / 4294967295;
}

function simulateOutcome(
  commitHash: string,
  environment: string,
): { status: "SUCCESS" | "FAILED"; durationSeconds: number } {
  const roll = hashToUnitInterval(commitHash + environment);
  const failureThreshold = environment === "PRODUCTION" ? 0.12 : 0.2;
  const status = roll < failureThreshold ? "FAILED" : "SUCCESS";
  // Duration scales loosely with environment (prod deploys run more
  // checks) and is derived from a different slice of the hash so it
  // doesn't correlate 1:1 with pass/fail.
  const durationRoll = hashToUnitInterval(environment + commitHash);
  const base = environment === "PRODUCTION" ? 90 : 30;
  const spread = environment === "PRODUCTION" ? 240 : 90;
  const durationSeconds = Math.round(base + durationRoll * spread);
  return { status, durationSeconds };
}

const createDeploymentSchema = z.object({
  environment: z.enum(ENVIRONMENTS).default("PRODUCTION"),
  commitHash: z
    .string()
    .min(4)
    .max(40)
    .regex(/^[0-9a-fA-F]+$/, "commitHash must be a hex SHA"),
  commitMessage: z.string().min(1).max(500),
  branch: z.string().min(1).max(200).optional(),
  projectId: z.string().uuid().nullable().optional(),
  pullRequestId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).optional(),
});

// POST /api/organizations/:organizationId/deployments
// MEMBER and above — mirrors pullRequests.ts's "MEMBER can create"
// convention. Runs the whole (simulated) pipeline synchronously: QUEUED
// -> IN_PROGRESS -> SUCCESS/FAILED, since there's no real CI runner to
// asynchronously report back. A real webhook-based provider would instead
// create the row QUEUED and PATCH it to IN_PROGRESS/SUCCESS/FAILED as
// events arrive — this endpoint is written so that swap only touches this
// one handler.
router.post(
  "/organizations/:organizationId/deployments",
  resolveOrgFromParam("organizationId"),
  requireRole("MEMBER"),
  async (req: OrgScopedRequest, res) => {
    const parsed = createDeploymentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const data = parsed.data;
    const organizationId = req.organizationId!;

    if (data.projectId) {
      const project = await prisma.project.findUnique({
        where: { id: data.projectId },
      });
      if (!project || project.organizationId !== organizationId) {
        return res.status(404).json({ error: "Project not found" });
      }
    }

    if (data.pullRequestId) {
      const pr = await prisma.pullRequest.findUnique({
        where: { id: data.pullRequestId },
      });
      if (!pr || pr.organizationId !== organizationId) {
        return res.status(404).json({ error: "Pull request not found" });
      }
    }

    const startedAt = new Date();
    const { status, durationSeconds } = simulateOutcome(
      data.commitHash,
      data.environment,
    );
    const completedAt = new Date(startedAt.getTime() + durationSeconds * 1000);

    const created = await prisma.deployment.create({
      data: {
        environment: data.environment,
        status,
        health: status === "SUCCESS" ? "HEALTHY" : "UNKNOWN",
        commitHash: data.commitHash,
        commitMessage: data.commitMessage,
        branch: data.branch ?? "main",
        notes: data.notes,
        organizationId,
        projectId: data.projectId ?? null,
        pullRequestId: data.pullRequestId ?? null,
        triggeredById: req.userId!,
        startedAt,
        completedAt,
        durationSeconds,
        healthCheckedAt: status === "SUCCESS" ? completedAt : null,
      },
      include: deploymentInclude(),
    });

    await logActivity({
      organizationId,
      userId: req.userId!,
      action: ActivityAction.DEPLOYMENT_CREATED,
      metadata: {
        deploymentId: created.id,
        environment: data.environment,
        status,
        commitHash: data.commitHash,
      },
    });

    // Notify every org member on a failed production deploy — this is
    // the one deployment event urgent enough to interrupt people, same
    // reasoning as meetings.ts only notifying on RSVP-affecting changes.
    // Preview/staging/dev failures and all successes just show up in the
    // feed without pinging anyone.
    if (status === "FAILED" && data.environment === "PRODUCTION") {
      const memberIds = (
        await prisma.membership.findMany({
          where: { organizationId },
          select: { userId: true },
        })
      ).map((m) => m.userId);

      await notifyMany(
        memberIds,
        {
          organizationId,
          type: NotificationType.DEPLOYMENT_FAILED,
          message: `Production deployment ${data.commitHash.slice(0, 7)} failed`,
          deploymentId: created.id,
          actorId: req.userId!,
        },
        req.userId!,
      );
    } else if (status === "SUCCESS" && data.pullRequestId) {
      // Let the PR author know their change actually shipped — closes the
      // loop the "merge" notification opened, same "who should know"
      // reasoning as pullRequests.ts's merge handler.
      const pr = await prisma.pullRequest.findUnique({
        where: { id: data.pullRequestId },
        select: { authorId: true, title: true },
      });
      if (pr && pr.authorId !== req.userId) {
        await notify({
          recipientId: pr.authorId,
          organizationId,
          type: NotificationType.DEPLOYMENT_SUCCEEDED,
          message: `"${pr.title}" deployed to ${data.environment.toLowerCase()}`,
          deploymentId: created.id,
          actorId: req.userId!,
        });
      }
    }

    res.status(201).json(created);
  },
);

const listDeploymentsQuerySchema = paginationQuerySchema.extend({
  environment: z.enum(ENVIRONMENTS).optional(),
  status: z.enum(STATUSES).optional(),
  health: z.enum(HEALTHS).optional(),
  projectId: z.string().uuid().optional(),
});

// GET /api/organizations/:organizationId/deployments?environment=&status=&health=&projectId=&cursor=&limit=
// Cursor-paginated like pull requests/issues — deploy volume in an active
// org grows unboundedly over time.
router.get(
  "/organizations/:organizationId/deployments",
  resolveOrgFromParam("organizationId"),
  requireRole("VIEWER"),
  async (req: OrgScopedRequest, res) => {
    const parsedQuery = listDeploymentsQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({ error: parsedQuery.error.flatten() });
    }
    const { environment, status, health, projectId, ...pagination } =
      parsedQuery.data;

    let paginationArgs;
    try {
      paginationArgs = buildPaginationArgs(pagination);
    } catch {
      return res.status(400).json({ error: "Invalid cursor" });
    }

    const rows = await prisma.deployment.findMany({
      where: {
        organizationId: req.organizationId!,
        environment,
        status,
        health,
        projectId,
      },
      ...paginationArgs,
      include: deploymentInclude(),
    });

    const { data, hasNextPage, nextCursor } = paginateResults(
      rows,
      pagination.limit,
    );
    res.json({ data, hasNextPage, nextCursor });
  },
);

// GET /api/organizations/:organizationId/deployments/metrics/dora?environment=&days=
// The four DORA (DevOps Research and Assessment) keys, computed straight
// from the Deployment table with no extra schema needed:
//   - Deployment frequency: successful deploys per day in the window
//   - Lead time for changes: hours from a linked PR's merge to its deploy
//   - Change failure rate: % of deploys that FAILED or were ROLLED_BACK
//   - MTTR: mean hours between a failed/rolled-back prod deploy and the
//     next successful one after it
// Bucketed into Elite/High/Medium/Low using the thresholds from Google's
// published State of DevOps research — gives a team an instantly
// legible read on where they stand, not just raw numbers.
router.get(
  "/organizations/:organizationId/deployments/metrics/dora",
  resolveOrgFromParam("organizationId"),
  requireRole("VIEWER"),
  async (req: OrgScopedRequest, res) => {
    const querySchema = z.object({
      environment: z.enum(ENVIRONMENTS).optional().default("PRODUCTION"),
      days: z.coerce.number().int().positive().max(365).optional().default(30),
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { environment, days } = parsed.data;
    const organizationId = req.organizationId!;
    const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const deployments = await prisma.deployment.findMany({
      where: {
        organizationId,
        environment,
        createdAt: { gte: windowStart },
      },
      orderBy: { createdAt: "asc" },
      include: {
        pullRequest: { select: { mergedAt: true } },
      },
    });

    const total = deployments.length;
    const successful = deployments.filter((d) => d.status === "SUCCESS");
    const failedOrRolledBack = deployments.filter(
      (d) => d.status === "FAILED" || d.status === "ROLLED_BACK",
    );

    // Deployment frequency: successful deploys per day.
    const deploymentsPerDay = total === 0 ? 0 : successful.length / days;

    // Lead time for changes: hours from PR merge to this deploy's
    // completion, averaged across deploys that have a linked, merged PR.
    const leadTimes: number[] = [];
    for (const d of deployments) {
      if (d.pullRequest?.mergedAt && d.completedAt) {
        const hours =
          (d.completedAt.getTime() - d.pullRequest.mergedAt.getTime()) /
          3600000;
        if (hours >= 0) leadTimes.push(hours);
      }
    }
    const leadTimeForChangesHours =
      leadTimes.length === 0
        ? null
        : leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length;

    // Change failure rate: % of deploys that failed or were rolled back.
    const changeFailureRatePercent =
      total === 0 ? 0 : (failedOrRolledBack.length / total) * 100;

    // MTTR: for each failed/rolled-back deploy, find the next SUCCESS
    // deploy after it and measure the gap. Deploys already sorted asc.
    const recoveryTimes: number[] = [];
    for (let i = 0; i < deployments.length; i++) {
      const d = deployments[i];
      if (d.status !== "FAILED" && d.status !== "ROLLED_BACK") continue;
      const failedAt = d.completedAt ?? d.createdAt;
      const nextSuccess = deployments
        .slice(i + 1)
        .find((next) => next.status === "SUCCESS");
      if (nextSuccess?.completedAt) {
        const hours =
          (nextSuccess.completedAt.getTime() - failedAt.getTime()) / 3600000;
        if (hours >= 0) recoveryTimes.push(hours);
      }
    }
    const mttrHours =
      recoveryTimes.length === 0
        ? null
        : recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length;

    // Elite/High/Medium/Low tiers, per Google's DORA research thresholds.
    function frequencyTier(perDay: number): string {
      if (perDay >= 1) return "Elite";
      if (perDay >= 1 / 7) return "High";
      if (perDay >= 1 / 30) return "Medium";
      return "Low";
    }
    function leadTimeTier(hours: number | null): string {
      if (hours === null) return "Unknown";
      if (hours < 24) return "Elite";
      if (hours < 24 * 7) return "High";
      if (hours < 24 * 30 * 6) return "Medium";
      return "Low";
    }
    function failureRateTier(percent: number): string {
      if (percent <= 15) return "Elite";
      if (percent <= 30) return "High";
      if (percent <= 45) return "Medium";
      return "Low";
    }
    function mttrTier(hours: number | null): string {
      if (hours === null) return "Unknown";
      if (hours < 1) return "Elite";
      if (hours < 24) return "High";
      if (hours < 24 * 7) return "Medium";
      return "Low";
    }

    res.json({
      environment,
      windowDays: days,
      totalDeployments: total,
      deploymentFrequency: {
        perDay: Number(deploymentsPerDay.toFixed(3)),
        tier: frequencyTier(deploymentsPerDay),
      },
      leadTimeForChanges: {
        hours:
          leadTimeForChangesHours === null
            ? null
            : Number(leadTimeForChangesHours.toFixed(1)),
        tier: leadTimeTier(leadTimeForChangesHours),
        sampleSize: leadTimes.length,
      },
      changeFailureRate: {
        percent: Number(changeFailureRatePercent.toFixed(1)),
        tier: failureRateTier(changeFailureRatePercent),
      },
      mttr: {
        hours: mttrHours === null ? null : Number(mttrHours.toFixed(1)),
        tier: mttrTier(mttrHours),
        sampleSize: recoveryTimes.length,
      },
    });
  },
);

// GET /api/deployments/:deploymentId
router.get(
  "/deployments/:deploymentId",
  resolveOrgFromDeployment,
  requireRole("VIEWER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const deploymentId = req.params.deploymentId as string;
    const deployment = await prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: deploymentInclude(),
    });
    if (!deployment) return res.status(404).json({ error: "Not found" });
    res.json(deployment);
  },
);

const updateStatusSchema = z.object({
  status: z.enum(["SUCCESS", "FAILED"]),
  notes: z.string().max(2000).optional(),
});

// PATCH /api/deployments/:deploymentId/status
// Manually resolves an IN_PROGRESS/QUEUED deployment — the hook a real
// CI/CD webhook receiver would call instead of the synchronous simulation
// in the create handler. Kept even though create() resolves synchronously
// today, so a future webhook integration (or a demo "mark as failed for
// testing the incident flow" button) has a real endpoint to call.
router.patch(
  "/deployments/:deploymentId/status",
  resolveOrgFromDeployment,
  requireRole("MEMBER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const deploymentId = req.params.deploymentId as string;
    const parsed = updateStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const existing = await prisma.deployment.findUnique({
      where: { id: deploymentId },
    });
    if (!existing) return res.status(404).json({ error: "Not found" });
    if (existing.status !== "QUEUED" && existing.status !== "IN_PROGRESS") {
      return res.status(409).json({ error: "Deployment has already finished" });
    }

    const completedAt = new Date();
    const startedAt = existing.startedAt ?? existing.createdAt;
    const durationSeconds = Math.round(
      (completedAt.getTime() - startedAt.getTime()) / 1000,
    );

    const updated = await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: parsed.data.status,
        notes: parsed.data.notes ?? existing.notes,
        startedAt,
        completedAt,
        durationSeconds,
        health: parsed.data.status === "SUCCESS" ? "HEALTHY" : existing.health,
        healthCheckedAt:
          parsed.data.status === "SUCCESS"
            ? completedAt
            : existing.healthCheckedAt,
      },
      include: deploymentInclude(),
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.DEPLOYMENT_STATUS_CHANGED,
      metadata: { deploymentId, status: parsed.data.status },
    });

    if (
      parsed.data.status === "FAILED" &&
      existing.environment === "PRODUCTION"
    ) {
      const memberIds = (
        await prisma.membership.findMany({
          where: { organizationId: req.organizationId! },
          select: { userId: true },
        })
      ).map((m) => m.userId);
      await notifyMany(
        memberIds,
        {
          organizationId: req.organizationId!,
          type: NotificationType.DEPLOYMENT_FAILED,
          message: `Production deployment ${existing.commitHash.slice(0, 7)} failed`,
          deploymentId,
          actorId: req.userId!,
        },
        req.userId!,
      );
    }

    res.json(updated);
  },
);

const healthSchema = z.object({
  health: z.enum(["HEALTHY", "DEGRADED", "UNHEALTHY"]),
  notes: z.string().max(2000).optional(),
});

// POST /api/deployments/:deploymentId/health
// Synthetic health check — anyone can "run" one (VIEWER+, same as
// submitting a PR review), simulating a post-deploy monitoring ping. A
// real integration (Datadog/Sentry/uptime check) would call this same
// endpoint from a webhook instead of a human clicking a button; nothing
// else in the system needs to change for that swap.
router.post(
  "/deployments/:deploymentId/health",
  resolveOrgFromDeployment,
  requireRole("VIEWER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const deploymentId = req.params.deploymentId as string;
    const parsed = healthSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const existing = await prisma.deployment.findUnique({
      where: { id: deploymentId },
    });
    if (!existing) return res.status(404).json({ error: "Not found" });

    const updated = await prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        health: parsed.data.health,
        healthCheckedAt: new Date(),
        notes: parsed.data.notes ?? existing.notes,
      },
      include: deploymentInclude(),
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.DEPLOYMENT_HEALTH_CHECKED,
      metadata: { deploymentId, health: parsed.data.health },
    });

    // Degraded/unhealthy production is exactly the signal that should
    // interrupt people — same "urgent enough to ping" bar as a failed
    // deploy above.
    if (
      parsed.data.health !== "HEALTHY" &&
      existing.environment === "PRODUCTION"
    ) {
      const memberIds = (
        await prisma.membership.findMany({
          where: { organizationId: req.organizationId! },
          select: { userId: true },
        })
      ).map((m) => m.userId);
      await notifyMany(
        memberIds,
        {
          organizationId: req.organizationId!,
          type: NotificationType.DEPLOYMENT_FAILED,
          message: `Production deployment ${existing.commitHash.slice(0, 7)} is ${parsed.data.health.toLowerCase()}`,
          deploymentId,
          actorId: req.userId!,
        },
        req.userId!,
      );
    }

    res.json(updated);
  },
);

const rollbackSchema = z.object({
  targetDeploymentId: z.string().uuid(),
  reason: z.string().max(2000).optional(),
});

// POST /api/deployments/:deploymentId/rollback
// The payoff feature: instantly restores an environment to a previous,
// known-good deployment. `:deploymentId` is the CURRENT (bad) deployment;
// `targetDeploymentId` in the body is the deployment being restored to.
// This creates a brand-new Deployment row (rollbacks are themselves
// deploys, worth their own place in the timeline and DORA stats) linked
// back via previousDeploymentId, and marks the bad one ROLLED_BACK.
// Manager+ only — same bar as pullRequests.ts's merge/close actions,
// since a rollback is a blunt, org-wide-impacting action.
router.post(
  "/deployments/:deploymentId/rollback",
  resolveOrgFromDeployment,
  requireRole("MANAGER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const deploymentId = req.params.deploymentId as string;
    const parsed = rollbackSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const [current, target] = await Promise.all([
      prisma.deployment.findUnique({ where: { id: deploymentId } }),
      prisma.deployment.findUnique({
        where: { id: parsed.data.targetDeploymentId },
      }),
    ]);
    if (!current) return res.status(404).json({ error: "Not found" });
    if (!target || target.organizationId !== req.organizationId) {
      return res.status(404).json({ error: "Target deployment not found" });
    }
    if (target.environment !== current.environment) {
      return res.status(400).json({
        error: "Can only roll back to a deployment in the same environment",
      });
    }
    if (target.status !== "SUCCESS") {
      return res.status(400).json({
        error: "Can only roll back to a deployment that previously succeeded",
      });
    }

    const now = new Date();
    // Rollbacks are fast — restoring a known-good build/config rather
    // than rebuilding from source — so this is a short, fixed duration
    // rather than another simulateOutcome() roll. Rollbacks are also
    // treated as always succeeding: if the "known good" build can't be
    // restored, that's a much bigger incident than this feature models.
    const rollbackDurationSeconds = 20;

    const [, rollbackDeployment] = await prisma.$transaction([
      prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          status: "ROLLED_BACK",
          rolledBackAt: now,
          rolledBackById: req.userId!,
          notes: parsed.data.reason ?? current.notes,
        },
      }),
      prisma.deployment.create({
        data: {
          environment: current.environment,
          status: "SUCCESS",
          health: "HEALTHY",
          commitHash: target.commitHash,
          commitMessage: `Rollback to ${target.commitHash.slice(0, 7)}: ${target.commitMessage}`,
          branch: target.branch,
          organizationId: req.organizationId!,
          projectId: current.projectId,
          pullRequestId: target.pullRequestId,
          triggeredById: req.userId!,
          previousDeploymentId: target.id,
          startedAt: now,
          completedAt: new Date(now.getTime() + rollbackDurationSeconds * 1000),
          durationSeconds: rollbackDurationSeconds,
          healthCheckedAt: now,
          notes: parsed.data.reason,
        },
        include: deploymentInclude(),
      }),
    ]);

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.DEPLOYMENT_ROLLED_BACK,
      metadata: {
        rolledBackDeploymentId: deploymentId,
        restoredToDeploymentId: target.id,
        newDeploymentId: rollbackDeployment.id,
        environment: current.environment,
      },
    });

    // Rolling back is itself an org-wide-relevant event — let everyone
    // know the environment is stable again, not just the person who
    // triggered the original bad deploy.
    if (current.environment === "PRODUCTION") {
      const memberIds = (
        await prisma.membership.findMany({
          where: { organizationId: req.organizationId! },
          select: { userId: true },
        })
      ).map((m) => m.userId);
      await notifyMany(
        memberIds,
        {
          organizationId: req.organizationId!,
          type: NotificationType.DEPLOYMENT_SUCCEEDED,
          message: `Production rolled back to ${target.commitHash.slice(0, 7)}`,
          deploymentId: rollbackDeployment.id,
          actorId: req.userId!,
        },
        req.userId!,
      );
    }

    res.status(201).json(rollbackDeployment);
  },
);

export default router;
