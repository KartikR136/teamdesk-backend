import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole, OrgScopedRequest } from "../middleware/requireRole";
import {
  resolveOrgFromParam,
  resolveOrgFromDecision,
} from "../lib/resolveOrgContext";
import {
  paginationQuerySchema,
  buildPaginationArgs,
  paginateResults,
} from "../lib/pagination";
import { logActivity, ActivityAction } from "../lib/activityLog";

const router = Router();
router.use(requireAuth);

const DECISION_STATUSES = [
  "DRAFT",
  "ACCEPTED",
  "SUPERSEDED",
  "ARCHIVED",
] as const;

const decisionInclude = {
  author: { select: { id: true, name: true } },
  project: { select: { id: true, name: true } },
  relatedIssues: {
    include: { issue: { select: { id: true, title: true, status: true } } },
  },
};

// Shared by create/update — every text field required on create, optional
// on update. Capped lengths mirror comments.ts's reasoning: generous for
// real use, not unbounded (an unbounded field lets a single request bloat
// storage/response payloads indefinitely).
const decisionBodySchema = z.object({
  title: z.string().min(1).max(200),
  problemStatement: z.string().min(1).max(5000),
  context: z.string().min(1).max(5000),
  alternatives: z.string().min(1).max(5000),
  chosenSolution: z.string().min(1).max(5000),
  tradeoffs: z.string().min(1).max(5000),
  consequences: z.string().max(5000).optional(),
  projectId: z.string().uuid().nullable().optional(),
  reviewDate: z.string().datetime().nullable().optional(),
  // Issue IDs this decision relates to. Verified server-side against the
  // resolved org before being written — same defense-in-depth pattern
  // issues.ts uses for a client-supplied projectId.
  relatedIssueIds: z.array(z.string().uuid()).max(50).optional(),
});

const updateDecisionBodySchema = decisionBodySchema.partial();

const statusChangeSchema = z.object({
  status: z.enum(DECISION_STATUSES),
});

async function verifyIssuesBelongToOrg(
  issueIds: string[],
  organizationId: string,
): Promise<boolean> {
  if (issueIds.length === 0) return true;
  const count = await prisma.issue.count({
    where: { id: { in: issueIds }, organizationId },
  });
  return count === issueIds.length;
}

// POST /api/organizations/:organizationId/decisions
router.post(
  "/organizations/:organizationId/decisions",
  resolveOrgFromParam("organizationId"),
  requireRole("MEMBER"),
  async (req: OrgScopedRequest, res) => {
    const parsed = decisionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const organizationId = req.organizationId!;
    const { relatedIssueIds = [], projectId, reviewDate, ...fields } =
      parsed.data;

    // Defense in depth, same reasoning as issues.ts: even though the user
    // passed requireRole for this org, explicitly verify any referenced
    // project/issues actually belong to the SAME org before writing
    // anything — otherwise a member of Org A could pass Org A's
    // requireRole check but reference a projectId/issueId from Org B.
    if (projectId) {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
      });
      if (!project || project.organizationId !== organizationId) {
        return res.status(404).json({ error: "Project not found" });
      }
    }

    if (!(await verifyIssuesBelongToOrg(relatedIssueIds, organizationId))) {
      return res
        .status(404)
        .json({ error: "One or more related issues were not found" });
    }

    const decision = await prisma.decisionLog.create({
      data: {
        ...fields,
        organizationId,
        authorId: req.userId!,
        projectId: projectId ?? undefined,
        reviewDate: reviewDate ? new Date(reviewDate) : undefined,
        relatedIssues: {
          create: relatedIssueIds.map((issueId) => ({ issueId })),
        },
      },
      include: decisionInclude,
    });

    await logActivity({
      organizationId,
      userId: req.userId!,
      action: ActivityAction.DECISION_CREATED,
      decisionId: decision.id,
      metadata: { title: decision.title },
    });

    res.status(201).json(decision);
  },
);

// GET /api/organizations/:organizationId/decisions
// Optional ?status= filter — matches the activity feed's existing
// "filter-chip row reserved, only wired when a real query param exists"
// pattern named in ROADMAP.md, except here the query param genuinely
// exists from day one since it costs nothing extra to add up front.
router.get(
  "/organizations/:organizationId/decisions",
  resolveOrgFromParam("organizationId"),
  requireRole("VIEWER"),
  async (req: OrgScopedRequest, res) => {
    const parsedQuery = paginationQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({ error: parsedQuery.error.flatten() });
    }

    const statusFilter = z
      .enum(DECISION_STATUSES)
      .optional()
      .safeParse(req.query.status);
    if (!statusFilter.success) {
      return res.status(400).json({ error: "Invalid status filter" });
    }

    let paginationArgs;
    try {
      paginationArgs = buildPaginationArgs(parsedQuery.data);
    } catch {
      return res.status(400).json({ error: "Invalid cursor" });
    }

    const decisions = await prisma.decisionLog.findMany({
      where: {
        organizationId: req.organizationId!,
        ...(statusFilter.data ? { status: statusFilter.data } : {}),
      },
      include: {
        author: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
      },
      ...paginationArgs,
    });

    const { data, hasNextPage, nextCursor } = paginateResults(
      decisions,
      parsedQuery.data.limit,
    );

    res.json({ data, hasNextPage, nextCursor });
  },
);

// GET /api/decisions/:decisionId
router.get(
  "/decisions/:decisionId",
  resolveOrgFromDecision,
  requireRole("VIEWER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const decisionId = req.params.decisionId;
    if (typeof decisionId !== "string") {
      return res.status(400).json({ error: "Invalid decision id" });
    }

    const decision = await prisma.decisionLog.findUnique({
      where: { id: decisionId },
      include: decisionInclude,
    });

    if (!decision) {
      return res.status(404).json({ error: "Decision not found" });
    }

    res.json(decision);
  },
);

// PATCH /api/decisions/:decisionId
// Author-only, or ADMIN as a moderation override — identical rule to
// comments.ts's edit/delete ownership check.
router.patch(
  "/decisions/:decisionId",
  resolveOrgFromDecision,
  requireRole("VIEWER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const parsed = updateDecisionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const decisionId = req.params.decisionId;
    if (typeof decisionId !== "string") {
      return res.status(400).json({ error: "Invalid decision id" });
    }

    const existing = await prisma.decisionLog.findUnique({
      where: { id: decisionId },
      select: { authorId: true, organizationId: true },
    });
    if (!existing) {
      return res.status(404).json({ error: "Decision not found" });
    }

    const isAuthor = existing.authorId === req.userId;
    const isAdmin = req.membershipRole === "ADMIN";
    if (!isAuthor && !isAdmin) {
      return res.status(403).json({
        error: "Only the decision's author or an admin can edit it",
      });
    }

    const { relatedIssueIds, projectId, reviewDate, ...fields } = parsed.data;
    const organizationId = existing.organizationId;

    if (projectId) {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
      });
      if (!project || project.organizationId !== organizationId) {
        return res.status(404).json({ error: "Project not found" });
      }
    }

    if (
      relatedIssueIds &&
      !(await verifyIssuesBelongToOrg(relatedIssueIds, organizationId))
    ) {
      return res
        .status(404)
        .json({ error: "One or more related issues were not found" });
    }

    const updated = await prisma.decisionLog.update({
      where: { id: decisionId },
      data: {
        ...fields,
        ...(projectId !== undefined ? { projectId } : {}),
        ...(reviewDate !== undefined
          ? { reviewDate: reviewDate ? new Date(reviewDate) : null }
          : {}),
        // Relations are fully replaced on update, not merged — simplest
        // correct behavior for a "these are the related issues now" field,
        // same reasoning PATCH /issues/:issueId uses for a full-subset update.
        ...(relatedIssueIds
          ? {
              relatedIssues: {
                deleteMany: {},
                create: relatedIssueIds.map((issueId) => ({ issueId })),
              },
            }
          : {}),
      },
      include: decisionInclude,
    });

    await logActivity({
      organizationId,
      userId: req.userId!,
      action: ActivityAction.DECISION_UPDATED,
      decisionId: updated.id,
      metadata: { title: updated.title },
    });

    res.json(updated);
  },
);

// PATCH /api/decisions/:decisionId/status
// Separate endpoint, not folded into the general PATCH above — a status
// transition (e.g. ACCEPTED -> SUPERSEDED) is a distinct, audit-worthy
// engineering event on this resource, not a routine field edit. Same
// author-or-admin ownership rule as the general edit.
router.patch(
  "/decisions/:decisionId/status",
  resolveOrgFromDecision,
  requireRole("VIEWER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const parsed = statusChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const decisionId = req.params.decisionId;
    if (typeof decisionId !== "string") {
      return res.status(400).json({ error: "Invalid decision id" });
    }

    const existing = await prisma.decisionLog.findUnique({
      where: { id: decisionId },
      select: { authorId: true, organizationId: true, status: true },
    });
    if (!existing) {
      return res.status(404).json({ error: "Decision not found" });
    }

    const isAuthor = existing.authorId === req.userId;
    const isAdmin = req.membershipRole === "ADMIN";
    if (!isAuthor && !isAdmin) {
      return res.status(403).json({
        error: "Only the decision's author or an admin can change its status",
      });
    }

    const updated = await prisma.decisionLog.update({
      where: { id: decisionId },
      data: { status: parsed.data.status },
      include: decisionInclude,
    });

    await logActivity({
      organizationId: existing.organizationId,
      userId: req.userId!,
      action: ActivityAction.DECISION_STATUS_CHANGED,
      decisionId: updated.id,
      metadata: { from: existing.status, to: parsed.data.status },
    });

    res.json(updated);
  },
);

// DELETE /api/decisions/:decisionId
// Same ownership rule as edit.
router.delete(
  "/decisions/:decisionId",
  resolveOrgFromDecision,
  requireRole("VIEWER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const decisionId = req.params.decisionId;
    if (typeof decisionId !== "string") {
      return res.status(400).json({ error: "Invalid decision id" });
    }

    const existing = await prisma.decisionLog.findUnique({
      where: { id: decisionId },
      select: { authorId: true, organizationId: true },
    });
    if (!existing) {
      return res.status(404).json({ error: "Decision not found" });
    }

    const isAuthor = existing.authorId === req.userId;
    const isAdmin = req.membershipRole === "ADMIN";
    if (!isAuthor && !isAdmin) {
      return res.status(403).json({
        error: "Only the decision's author or an admin can delete it",
      });
    }

    await prisma.decisionLog.delete({ where: { id: decisionId } });

    // Logged after the delete succeeds, using context captured before the
    // row was removed — same reasoning as comments.ts's DELETE handler.
    await logActivity({
      organizationId: existing.organizationId,
      userId: req.userId!,
      action: ActivityAction.DECISION_DELETED,
      metadata: { decisionId },
    });

    res.status(204).send();
  },
);

export default router;
