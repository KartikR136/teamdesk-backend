import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole, OrgScopedRequest } from "../middleware/requireRole";
import {
  resolveOrgFromParam,
  resolveOrgFromPullRequest,
  resolveOrgFromPullRequestComment,
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

const MERGE_STATUSES = ["CLEAN", "CONFLICTS", "CHECKS_FAILING"] as const;
const PR_STATUSES = ["OPEN", "MERGED", "CLOSED"] as const;
const REVIEW_STATUSES = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"] as const;

// Shared response shape for a single PR — the detail page and the list
// page both need author, reviewers (with status), linked issues, and
// comment count. Kept as one function so create/list/get/patch can't
// drift from each other, same convention as meetings.ts's
// meetingInclude().
function prInclude() {
  return {
    author: { select: { id: true, name: true, email: true } },
    project: { select: { id: true, name: true } },
    reviewers: {
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { requestedAt: "asc" as const },
    },
    linkedIssues: {
      include: {
        issue: {
          select: {
            id: true,
            title: true,
            status: true,
            priority: true,
            projectId: true,
          },
        },
      },
    },
    _count: { select: { comments: true } },
  };
}

async function assertOrgMembers(
  organizationId: string,
  userIds: string[],
): Promise<boolean> {
  if (userIds.length === 0) return true;
  const count = await prisma.membership.count({
    where: { organizationId, userId: { in: userIds } },
  });
  return count === userIds.length;
}

async function assertOrgIssues(
  organizationId: string,
  issueIds: string[],
): Promise<boolean> {
  if (issueIds.length === 0) return true;
  const count = await prisma.issue.count({
    where: { organizationId, id: { in: issueIds } },
  });
  return count === issueIds.length;
}

const createPRSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(20000).optional(),
  repoName: z.string().min(1).max(200),
  sourceBranch: z.string().min(1).max(200),
  targetBranch: z.string().max(200).optional(),
  externalUrl: z.string().url().max(2000).optional(),
  filesChanged: z.number().int().min(0).max(100000).optional(),
  linesAdded: z.number().int().min(0).max(10000000).optional(),
  linesRemoved: z.number().int().min(0).max(10000000).optional(),
  projectId: z.string().uuid().nullable().optional(),
  reviewerUserIds: z.array(z.string().uuid()).max(50).optional(),
  linkedIssueIds: z.array(z.string().uuid()).max(50).optional(),
});

// POST /api/organizations/:organizationId/pull-requests
// MEMBER and above — mirrors meetings.ts's "MEMBER can create" convention.
router.post(
  "/organizations/:organizationId/pull-requests",
  resolveOrgFromParam("organizationId"),
  requireRole("MEMBER"),
  async (req: OrgScopedRequest, res) => {
    const parsed = createPRSchema.safeParse(req.body);
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

    // Defense in depth, same reasoning as meetings.ts's assertOrgMembers
    // check: a client could pass another org's user/issue ids alongside a
    // valid organizationId in the URL. Reject rather than silently drop.
    const reviewerUserIds = Array.from(
      new Set(data.reviewerUserIds ?? []),
    ).filter((id) => id !== req.userId); // author can't review their own PR

    if (!(await assertOrgMembers(organizationId, reviewerUserIds))) {
      return res.status(400).json({
        error: "One or more reviewers are not members of this organization",
      });
    }

    const linkedIssueIds = data.linkedIssueIds ?? [];
    if (!(await assertOrgIssues(organizationId, linkedIssueIds))) {
      return res.status(400).json({
        error: "One or more issues do not belong to this organization",
      });
    }

    const created = await prisma.pullRequest.create({
      data: {
        title: data.title,
        description: data.description,
        repoName: data.repoName,
        sourceBranch: data.sourceBranch,
        targetBranch: data.targetBranch ?? "main",
        externalUrl: data.externalUrl,
        filesChanged: data.filesChanged ?? 0,
        linesAdded: data.linesAdded ?? 0,
        linesRemoved: data.linesRemoved ?? 0,
        organizationId,
        projectId: data.projectId ?? null,
        authorId: req.userId!,
        reviewers: {
          create: reviewerUserIds.map((userId) => ({ userId })),
        },
        linkedIssues: {
          create: linkedIssueIds.map((issueId) => ({ issueId })),
        },
      },
      include: prInclude(),
    });

    await logActivity({
      organizationId,
      userId: req.userId!,
      action: ActivityAction.PR_CREATED,
      metadata: {
        pullRequestId: created.id,
        title: data.title,
        reviewerUserIds,
      },
    });

    await notifyMany(
      reviewerUserIds,
      {
        organizationId,
        type: NotificationType.PR_REVIEW_REQUESTED,
        message: `requested your review on "${data.title}"`,
        pullRequestId: created.id,
        actorId: req.userId!,
      },
      req.userId!,
    );

    res.status(201).json(created);
  },
);

const listPRsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(PR_STATUSES).optional(),
  projectId: z.string().uuid().optional(),
  authorId: z.string().uuid().optional(),
  // "awaiting my review" filter — same field the dashboard's
  // NativePullRequestProvider uses, exposed here so the full
  // /dashboard/pull-requests list page can offer the same view.
  reviewerId: z.string().uuid().optional(),
});

// GET /api/organizations/:organizationId/pull-requests?status=&projectId=&authorId=&reviewerId=&cursor=&limit=
// Cursor-paginated like issues/decisions — PR volume in an active org can
// grow unboundedly, unlike the bounded meeting-generator case.
router.get(
  "/organizations/:organizationId/pull-requests",
  resolveOrgFromParam("organizationId"),
  requireRole("VIEWER"),
  async (req: OrgScopedRequest, res) => {
    const parsedQuery = listPRsQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({ error: parsedQuery.error.flatten() });
    }
    const { status, projectId, authorId, reviewerId, ...pagination } =
      parsedQuery.data;

    let paginationArgs;
    try {
      paginationArgs = buildPaginationArgs(pagination);
    } catch {
      return res.status(400).json({ error: "Invalid cursor" });
    }

    const rows = await prisma.pullRequest.findMany({
      where: {
        organizationId: req.organizationId!,
        status,
        projectId,
        authorId,
        ...(reviewerId
          ? { reviewers: { some: { userId: reviewerId } } }
          : {}),
      },
      ...paginationArgs,
      include: prInclude(),
    });

    const { data, hasNextPage, nextCursor } = paginateResults(rows, pagination.limit);
    res.json({ data, hasNextPage, nextCursor });
  },
);

// GET /api/pull-requests/:pullRequestId
router.get(
  "/pull-requests/:pullRequestId",
  resolveOrgFromPullRequest,
  requireRole("VIEWER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const pullRequestId = req.params.pullRequestId as string;
    const pr = await prisma.pullRequest.findUnique({
      where: { id: pullRequestId },
      include: prInclude(),
    });
    if (!pr) return res.status(404).json({ error: "Not found" });
    res.json(pr);
  },
);

const updatePRSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(20000).nullable().optional(),
  targetBranch: z.string().max(200).optional(),
  mergeStatus: z.enum(MERGE_STATUSES).optional(),
  filesChanged: z.number().int().min(0).max(100000).optional(),
  linesAdded: z.number().int().min(0).max(10000000).optional(),
  linesRemoved: z.number().int().min(0).max(10000000).optional(),
  externalUrl: z.string().url().max(2000).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
});

// PATCH /api/pull-requests/:pullRequestId
// Author or manager+ only — same reasoning as meetings.ts's delete rule.
router.patch(
  "/pull-requests/:pullRequestId",
  resolveOrgFromPullRequest,
  requireRole("MEMBER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const pullRequestId = req.params.pullRequestId as string;
    const parsed = updatePRSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const existing = await prisma.pullRequest.findUnique({
      where: { id: pullRequestId },
    });
    if (!existing) return res.status(404).json({ error: "Not found" });

    const isAuthor = existing.authorId === req.userId;
    const isManagerPlus =
      req.membershipRole === "MANAGER" || req.membershipRole === "ADMIN";
    if (!isAuthor && !isManagerPlus) {
      return res
        .status(403)
        .json({ error: "Only the author or a manager can edit this pull request" });
    }

    if (parsed.data.projectId) {
      const project = await prisma.project.findUnique({
        where: { id: parsed.data.projectId },
      });
      if (!project || project.organizationId !== req.organizationId) {
        return res.status(404).json({ error: "Project not found" });
      }
    }

    const updated = await prisma.pullRequest.update({
      where: { id: pullRequestId },
      data: parsed.data,
      include: prInclude(),
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.PR_UPDATED,
      metadata: { pullRequestId: updated.id, ...parsed.data },
    });

    res.json(updated);
  },
);

// DELETE /api/pull-requests/:pullRequestId
// Author or manager+ only. A hard delete (unlike meetings, there's no
// "past occurrence" reason to keep it around) — closing without deleting
// is the POST .../close route below for teams that want an audit trail.
router.delete(
  "/pull-requests/:pullRequestId",
  resolveOrgFromPullRequest,
  requireRole("MEMBER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const pullRequestId = req.params.pullRequestId as string;
    const existing = await prisma.pullRequest.findUnique({
      where: { id: pullRequestId },
    });
    if (!existing) return res.status(404).json({ error: "Not found" });

    const isAuthor = existing.authorId === req.userId;
    const isManagerPlus =
      req.membershipRole === "MANAGER" || req.membershipRole === "ADMIN";
    if (!isAuthor && !isManagerPlus) {
      return res.status(403).json({
        error: "Only the author or a manager can delete this pull request",
      });
    }

    await prisma.pullRequest.delete({ where: { id: pullRequestId } });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.PR_CLOSED,
      metadata: { pullRequestId: existing.id, deleted: true },
    });

    res.status(204).send();
  },
);

const reviewersSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(50),
});

// POST /api/pull-requests/:pullRequestId/reviewers
// Author or manager+ can request reviewers — any authenticated member
// requesting review from arbitrary teammates on someone else's PR would
// be surprising, so this mirrors the update-permission rule above.
router.post(
  "/pull-requests/:pullRequestId/reviewers",
  resolveOrgFromPullRequest,
  requireRole("MEMBER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const pullRequestId = req.params.pullRequestId as string;
    const parsed = reviewersSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const pr = await prisma.pullRequest.findUnique({
      where: { id: pullRequestId },
    });
    if (!pr) return res.status(404).json({ error: "Not found" });

    const isAuthor = pr.authorId === req.userId;
    const isManagerPlus =
      req.membershipRole === "MANAGER" || req.membershipRole === "ADMIN";
    if (!isAuthor && !isManagerPlus) {
      return res.status(403).json({
        error: "Only the author or a manager can request reviewers",
      });
    }

    const userIds = Array.from(new Set(parsed.data.userIds)).filter(
      (id) => id !== pr.authorId,
    );
    if (!(await assertOrgMembers(req.organizationId!, userIds))) {
      return res.status(400).json({
        error: "One or more users are not members of this organization",
      });
    }

    await prisma.$transaction(
      userIds.map((userId) =>
        prisma.pullRequestReviewer.upsert({
          where: { pullRequestId_userId: { pullRequestId, userId } },
          update: {},
          create: { pullRequestId, userId },
        }),
      ),
    );

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.PR_REVIEWER_ADDED,
      metadata: { pullRequestId, userIds },
    });

    await notifyMany(
      userIds,
      {
        organizationId: req.organizationId!,
        type: NotificationType.PR_REVIEW_REQUESTED,
        message: `requested your review on "${pr.title}"`,
        pullRequestId,
        actorId: req.userId!,
      },
      req.userId!,
    );

    const updated = await prisma.pullRequest.findUnique({
      where: { id: pullRequestId },
      include: prInclude(),
    });
    res.status(201).json(updated);
  },
);

// DELETE /api/pull-requests/:pullRequestId/reviewers/:userId
router.delete(
  "/pull-requests/:pullRequestId/reviewers/:userId",
  resolveOrgFromPullRequest,
  requireRole("MEMBER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const pullRequestId = req.params.pullRequestId as string;
    const userId = req.params.userId as string;

    const pr = await prisma.pullRequest.findUnique({
      where: { id: pullRequestId },
    });
    if (!pr) return res.status(404).json({ error: "Not found" });

    const isAuthor = pr.authorId === req.userId;
    const isManagerPlus =
      req.membershipRole === "MANAGER" || req.membershipRole === "ADMIN";
    const isSelfRemoving = userId === req.userId; // a reviewer can remove themselves
    if (!isAuthor && !isManagerPlus && !isSelfRemoving) {
      return res.status(403).json({
        error: "Only the author, a manager, or the reviewer themself can remove this",
      });
    }

    await prisma.pullRequestReviewer.deleteMany({
      where: { pullRequestId, userId },
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.PR_REVIEWER_REMOVED,
      metadata: { pullRequestId, userId },
    });

    res.status(204).send();
  },
);

const reviewSchema = z.object({
  status: z.enum(REVIEW_STATUSES),
  comment: z.string().max(20000).optional(),
});

// PATCH /api/pull-requests/:pullRequestId/review
// The core "submit my review" action — any requested reviewer (or anyone
// self-adding as a reviewer of their own accord) can submit APPROVED /
// CHANGES_REQUESTED / COMMENTED, upserting a reviewer row the same way
// meetings.ts's RSVP upserts an attendee row.
router.patch(
  "/pull-requests/:pullRequestId/review",
  resolveOrgFromPullRequest,
  requireRole("VIEWER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const pullRequestId = req.params.pullRequestId as string;
    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const pr = await prisma.pullRequest.findUnique({
      where: { id: pullRequestId },
    });
    if (!pr) return res.status(404).json({ error: "Not found" });
    if (pr.authorId === req.userId) {
      return res
        .status(400)
        .json({ error: "You can't review your own pull request" });
    }

    const reviewer = await prisma.pullRequestReviewer.upsert({
      where: {
        pullRequestId_userId: { pullRequestId, userId: req.userId! },
      },
      update: { status: parsed.data.status, respondedAt: new Date() },
      create: {
        pullRequestId,
        userId: req.userId!,
        status: parsed.data.status,
        respondedAt: new Date(),
      },
    });

    if (parsed.data.comment) {
      await prisma.comment.create({
        data: {
          body: parsed.data.comment,
          pullRequestId,
          authorId: req.userId!,
        },
      });
    }

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.PR_REVIEW_SUBMITTED,
      metadata: { pullRequestId, status: parsed.data.status },
    });

    const verb =
      parsed.data.status === "APPROVED"
        ? "approved"
        : parsed.data.status === "CHANGES_REQUESTED"
          ? "requested changes on"
          : "commented on";
    await notify({
      recipientId: pr.authorId,
      organizationId: req.organizationId!,
      type: NotificationType.PR_REVIEW_SUBMITTED,
      message: `${verb} "${pr.title}"`,
      pullRequestId,
      actorId: req.userId!,
    });

    res.json(reviewer);
  },
);

// POST /api/pull-requests/:pullRequestId/merge
// Merging is the payoff for the whole feature: it flips status, stamps
// mergedAt, and auto-transitions every linked issue to DONE — the
// "connect a task to a PR" feature this milestone adds, mirroring how
// meetings.ts added "connect a task to a meeting". Requires either the
// author or a manager+, and (soft gate, not hard-blocking) warns via 409
// if there's an outstanding CHANGES_REQUESTED review that hasn't been
// re-reviewed, unless the caller passes force:true — real teams sometimes
// need to override a stale request-changes.
const mergeSchema = z.object({ force: z.boolean().optional() });

router.post(
  "/pull-requests/:pullRequestId/merge",
  resolveOrgFromPullRequest,
  requireRole("MEMBER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const pullRequestId = req.params.pullRequestId as string;
    const parsed = mergeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const pr = await prisma.pullRequest.findUnique({
      where: { id: pullRequestId },
      include: {
        reviewers: true,
        linkedIssues: { select: { issueId: true } },
      },
    });
    if (!pr) return res.status(404).json({ error: "Not found" });
    if (pr.status !== "OPEN") {
      return res.status(409).json({ error: "Pull request is not open" });
    }

    const isAuthor = pr.authorId === req.userId;
    const isManagerPlus =
      req.membershipRole === "MANAGER" || req.membershipRole === "ADMIN";
    if (!isAuthor && !isManagerPlus) {
      return res
        .status(403)
        .json({ error: "Only the author or a manager can merge this pull request" });
    }

    const hasOutstandingChangesRequested = pr.reviewers.some(
      (r) => r.status === "CHANGES_REQUESTED",
    );
    if (hasOutstandingChangesRequested && !parsed.data.force) {
      return res.status(409).json({
        error:
          "A reviewer has requested changes. Pass force:true to merge anyway.",
      });
    }

    const [updated] = await prisma.$transaction([
      prisma.pullRequest.update({
        where: { id: pullRequestId },
        data: { status: "MERGED", mergedAt: new Date() },
        include: prInclude(),
      }),
      ...(pr.linkedIssues.length > 0
        ? [
            prisma.issue.updateMany({
              where: { id: { in: pr.linkedIssues.map((li) => li.issueId) } },
              data: { status: "DONE" },
            }),
          ]
        : []),
    ]);

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.PR_MERGED,
      metadata: {
        pullRequestId,
        forced: hasOutstandingChangesRequested && !!parsed.data.force,
        autoClosedIssueIds: pr.linkedIssues.map((li) => li.issueId),
      },
    });

    if (pr.authorId !== req.userId) {
      await notify({
        recipientId: pr.authorId,
        organizationId: req.organizationId!,
        type: NotificationType.PR_MERGED,
        message: `merged "${pr.title}"`,
        pullRequestId,
        actorId: req.userId!,
      });
    }

    res.json(updated);
  },
);

// POST /api/pull-requests/:pullRequestId/close
// Closes without merging — e.g. abandoning a PR. Doesn't touch linked
// issues, unlike merge; an abandoned PR shouldn't silently mark work done.
router.post(
  "/pull-requests/:pullRequestId/close",
  resolveOrgFromPullRequest,
  requireRole("MEMBER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const pullRequestId = req.params.pullRequestId as string;
    const pr = await prisma.pullRequest.findUnique({
      where: { id: pullRequestId },
    });
    if (!pr) return res.status(404).json({ error: "Not found" });
    if (pr.status !== "OPEN") {
      return res.status(409).json({ error: "Pull request is not open" });
    }

    const isAuthor = pr.authorId === req.userId;
    const isManagerPlus =
      req.membershipRole === "MANAGER" || req.membershipRole === "ADMIN";
    if (!isAuthor && !isManagerPlus) {
      return res
        .status(403)
        .json({ error: "Only the author or a manager can close this pull request" });
    }

    const updated = await prisma.pullRequest.update({
      where: { id: pullRequestId },
      data: { status: "CLOSED", closedAt: new Date() },
      include: prInclude(),
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.PR_CLOSED,
      metadata: { pullRequestId },
    });

    res.json(updated);
  },
);

// POST /api/pull-requests/:pullRequestId/reopen
router.post(
  "/pull-requests/:pullRequestId/reopen",
  resolveOrgFromPullRequest,
  requireRole("MEMBER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const pullRequestId = req.params.pullRequestId as string;
    const pr = await prisma.pullRequest.findUnique({
      where: { id: pullRequestId },
    });
    if (!pr) return res.status(404).json({ error: "Not found" });
    if (pr.status === "OPEN") {
      return res.status(409).json({ error: "Pull request is already open" });
    }

    const isAuthor = pr.authorId === req.userId;
    const isManagerPlus =
      req.membershipRole === "MANAGER" || req.membershipRole === "ADMIN";
    if (!isAuthor && !isManagerPlus) {
      return res.status(403).json({
        error: "Only the author or a manager can reopen this pull request",
      });
    }

    const updated = await prisma.pullRequest.update({
      where: { id: pullRequestId },
      data: { status: "OPEN", closedAt: null, mergedAt: null },
      include: prInclude(),
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.PR_REOPENED,
      metadata: { pullRequestId },
    });

    res.json(updated);
  },
);

const linkIssueSchema = z.object({ issueId: z.string().uuid() });

// POST /api/pull-requests/:pullRequestId/issues
router.post(
  "/pull-requests/:pullRequestId/issues",
  resolveOrgFromPullRequest,
  requireRole("MEMBER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const pullRequestId = req.params.pullRequestId as string;
    const parsed = linkIssueSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const issue = await prisma.issue.findUnique({
      where: { id: parsed.data.issueId },
    });
    if (!issue || issue.organizationId !== req.organizationId) {
      return res.status(404).json({ error: "Issue not found" });
    }

    const link = await prisma.pullRequestLinkedIssue.upsert({
      where: {
        pullRequestId_issueId: {
          pullRequestId,
          issueId: parsed.data.issueId,
        },
      },
      update: {},
      create: { pullRequestId, issueId: parsed.data.issueId },
      include: {
        issue: {
          select: { id: true, title: true, status: true, priority: true },
        },
      },
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.PR_ISSUE_LINKED,
      issueId: parsed.data.issueId,
      metadata: { pullRequestId },
    });

    res.status(201).json(link);
  },
);

// DELETE /api/pull-requests/:pullRequestId/issues/:issueId
router.delete(
  "/pull-requests/:pullRequestId/issues/:issueId",
  resolveOrgFromPullRequest,
  requireRole("MEMBER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const pullRequestId = req.params.pullRequestId as string;
    const issueId = req.params.issueId as string;

    await prisma.pullRequestLinkedIssue.deleteMany({
      where: { pullRequestId, issueId },
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.PR_ISSUE_UNLINKED,
      issueId,
      metadata: { pullRequestId },
    });

    res.status(204).send();
  },
);

const createCommentSchema = z.object({ body: z.string().min(1).max(20000) });

// POST /api/pull-requests/:pullRequestId/comments
router.post(
  "/pull-requests/:pullRequestId/comments",
  resolveOrgFromPullRequest,
  requireRole("VIEWER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const pullRequestId = req.params.pullRequestId as string;
    const parsed = createCommentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const pr = await prisma.pullRequest.findUnique({
      where: { id: pullRequestId },
      select: { title: true, authorId: true, reviewers: { select: { userId: true } } },
    });
    if (!pr) return res.status(404).json({ error: "Not found" });

    const comment = await prisma.comment.create({
      data: {
        body: parsed.data.body,
        pullRequestId,
        authorId: req.userId!,
      },
      include: { author: { select: { id: true, name: true } } },
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.PR_COMMENT_CREATED,
      metadata: { pullRequestId, commentId: comment.id },
    });

    // Notify the author and every requested reviewer (excluding whoever
    // just commented) — same "who should know" reasoning as
    // comments.ts's issue-comment notification hook.
    const recipients = Array.from(
      new Set([pr.authorId, ...pr.reviewers.map((r) => r.userId)]),
    );
    await notifyMany(
      recipients,
      {
        organizationId: req.organizationId!,
        type: NotificationType.COMMENT,
        message: `commented on "${pr.title}"`,
        pullRequestId,
        actorId: req.userId!,
      },
      req.userId!,
    );

    res.status(201).json(comment);
  },
);

// GET /api/pull-requests/:pullRequestId/comments
router.get(
  "/pull-requests/:pullRequestId/comments",
  resolveOrgFromPullRequest,
  requireRole("VIEWER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const pullRequestId = req.params.pullRequestId as string;
    const comments = await prisma.comment.findMany({
      where: { pullRequestId },
      orderBy: { createdAt: "asc" },
      include: { author: { select: { id: true, name: true } } },
    });
    res.json({ data: comments });
  },
);

const updateCommentSchema = z.object({ body: z.string().min(1).max(20000) });

// PATCH /api/pr-comments/:commentId
router.patch(
  "/pr-comments/:commentId",
  resolveOrgFromPullRequestComment,
  requireRole("VIEWER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const commentId = req.params.commentId as string;
    const parsed = updateCommentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const existing = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { authorId: true, pullRequestId: true },
    });
    if (!existing) return res.status(404).json({ error: "Comment not found" });

    const isAuthor = existing.authorId === req.userId;
    const isAdmin = req.membershipRole === "ADMIN";
    if (!isAuthor && !isAdmin) {
      return res.status(403).json({
        error: "Only the comment author or an admin can edit this comment",
      });
    }

    const updated = await prisma.comment.update({
      where: { id: commentId },
      data: { body: parsed.data.body },
      include: { author: { select: { id: true, name: true } } },
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.PR_COMMENT_CREATED,
      metadata: { commentId: updated.id, pullRequestId: existing.pullRequestId, edited: true },
    });

    res.json(updated);
  },
);

// DELETE /api/pr-comments/:commentId
router.delete(
  "/pr-comments/:commentId",
  resolveOrgFromPullRequestComment,
  requireRole("VIEWER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const commentId = req.params.commentId as string;

    const existing = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { authorId: true, pullRequestId: true },
    });
    if (!existing) return res.status(404).json({ error: "Comment not found" });

    const isAuthor = existing.authorId === req.userId;
    const isAdmin = req.membershipRole === "ADMIN";
    if (!isAuthor && !isAdmin) {
      return res.status(403).json({
        error: "Only the comment author or an admin can delete this comment",
      });
    }

    await prisma.comment.delete({ where: { id: commentId } });

    res.status(204).send();
  },
);

export default router;
