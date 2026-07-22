import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole, OrgScopedRequest } from "../middleware/requireRole";
import {
  resolveOrgFromParam,
  resolveOrgFromIssue,
} from "../lib/resolveOrgContext";
import {
  paginationQuerySchema,
  buildPaginationArgs,
  paginateResults,
} from "../lib/pagination";
import { logActivity, ActivityAction } from "../lib/activityLog";
import { notify, NotificationType } from "../lib/notifications";
import { DashboardRepository } from "../modules/dashboard/repository/dashboard.repository";

const dashboardRepository = new DashboardRepository();

const router = Router();
router.use(requireAuth);

const createIssueSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  projectId: z.string().uuid(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  dueDate: z.string().datetime().optional(),
  estimatePoints: z.number().int().min(0).optional(),
});

router.post(
  "/organizations/:organizationId/issues",
  resolveOrgFromParam("organizationId"),
  requireRole("MEMBER"),
  async (req: OrgScopedRequest, res) => {
    const parsed = createIssueSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });

    // Defense in depth: even though the user passed requireRole for this org,
    // explicitly verify the target project actually belongs to the SAME org —
    // otherwise a member of Org A could pass Org A's requireRole check but
    // sneak in a projectId belonging to Org B.
    const project = await prisma.project.findUnique({
      where: { id: parsed.data.projectId },
    });
    if (!project || project.organizationId !== req.organizationId) {
      return res.status(404).json({ error: "Project not found" });
    }

    const issue = await prisma.issue.create({
      data: {
        title: parsed.data.title,
        description: parsed.data.description,
        projectId: parsed.data.projectId,
        organizationId: req.organizationId!,
        creatorId: req.userId!,
        priority: parsed.data.priority,
        dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : undefined,
        estimatePoints: parsed.data.estimatePoints,
      },
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.ISSUE_CREATED,
      issueId: issue.id,
      metadata: { title: issue.title, projectId: issue.projectId },
    });

    res.status(201).json(issue);
  },
);

const updateIssueSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  dueDate: z.string().datetime().nullable().optional(),
  estimatePoints: z.number().int().min(0).nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
});

router.patch(
  "/issues/:issueId",
  resolveOrgFromIssue, // derives organizationId from the issue itself — your exact answer, implemented
  requireRole("MEMBER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const parsed = updateIssueSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });

    const issueId = req.params.issueId;

    if (typeof issueId !== "string") {
      return res.status(400).json({ error: "Invalid issue id" });
    }

    // Fetched before the update purely to diff old vs. new assignee/status
    // for the notification hook below — does not change ISSUE_UPDATED's
    // own logging (still one event, not split into field-level events; see
    // note below).
    const before = await prisma.issue.findUnique({
      where: { id: issueId },
      select: { assigneeId: true, status: true, title: true },
    });

    const updateData = {
      ...parsed.data,
      dueDate:
        parsed.data.dueDate === undefined
          ? undefined
          : parsed.data.dueDate === null
            ? null
            : new Date(parsed.data.dueDate),
    };

    const updated = await prisma.issue.update({
      where: { id: issueId },
      data: updateData,
    });

    // Logged as a single ISSUE_UPDATED event carrying whichever fields the
    // client actually changed, rather than separate STATUS_CHANGED /
    // PRIORITY_CHANGED / ASSIGNEE_CHANGED events. Splitting those out would
    // need a pre-update fetch to diff old vs new values — deferred; this
    // milestone's scope is "Issue update" as one action, not a full field-
    // level audit trail.
    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.ISSUE_UPDATED,
      issueId: updated.id,
      metadata: parsed.data,
    });

    // Dashboard notifications — deliberately separate from the ISSUE_UPDATED
    // ActivityLog entry above (see notifications.ts: ActivityLog records
    // the actor, Notification records the recipient, and those are
    // frequently different people). Fire-and-forget; a failure here never
    // fails the request. They're awaited (not fire-and-forget) because
    // notify() already catches its own errors internally (see
    // src/lib/notifications.ts) — awaiting just makes the write complete
    // before the response, which matters under the test suite's
    // shared-process, shared-connection-pool execution (a truly
    // un-awaited write can still be in flight when a later test's
    // beforeEach truncates tables, causing FK errors and unrelated
    // timeouts elsewhere in the run).
    if (before) {
      const newlyAssignedId = parsed.data.assigneeId;
      if (
        newlyAssignedId &&
        newlyAssignedId !== before.assigneeId &&
        newlyAssignedId !== req.userId
      ) {
        await notify({
          recipientId: newlyAssignedId,
          organizationId: req.organizationId!,
          type: NotificationType.ASSIGNMENT,
          message: `You were assigned to "${before.title}"`,
          issueId: updated.id,
          actorId: req.userId!,
        });
      }

      if (
        parsed.data.status &&
        parsed.data.status !== before.status &&
        updated.assigneeId &&
        updated.assigneeId !== req.userId
      ) {
        await notify({
          recipientId: updated.assigneeId,
          organizationId: req.organizationId!,
          type: NotificationType.STATUS_CHANGE,
          message: `"${updated.title}" changed to ${updated.status}`,
          issueId: updated.id,
          actorId: req.userId!,
        });
      }
    }

    res.json(updated);
  },
);
// GET /issues/:issueId — returns the full issue plus its comments in one
// response, so the frontend detail page needs a single fetch instead of
// a waterfall (fetch issue, then fetch comments).
router.get(
  "/issues/:issueId",
  resolveOrgFromIssue,
  requireRole("VIEWER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const issueId = req.params.issueId;

    if (typeof issueId !== "string") {
      return res.status(400).json({ error: "Invalid issue id" });
    }

    const issue = await prisma.issue.findUnique({
      where: { id: issueId },
      include: {
        creator: { select: { id: true, name: true } },
        assignee: { select: { id: true, name: true } },
        comments: {
          orderBy: { createdAt: "desc" },
          include: { author: { select: { id: true, name: true } } },
        },
      },
    });

    if (!issue) {
      return res.status(404).json({ error: "Issue not found" });
    }

    // Dashboard "Recently Viewed Issues" hook. Awaited (not fire-and-forget)
    // — errors are still swallowed via .catch() below so this never turns
    // a successful GET into an error, but awaiting it means the write is
    // guaranteed to complete before the response, avoiding cross-test races
    // and connection-pool pressure under the test suite's shared-process
    // execution (see the identical note on notify() calls in PATCH above).
    await dashboardRepository
      .recordIssueView(req.userId!, issue.id)
      .catch((err) =>
        console.error("Failed to record recently-viewed issue:", err),
      );

    res.json(issue);
  },
);

router.get(
  "/organizations/:organizationId/issues",
  resolveOrgFromParam("organizationId"),
  requireRole("VIEWER"),
  async (req: OrgScopedRequest, res) => {
    const parsedQuery = paginationQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({ error: parsedQuery.error.flatten() });
    }

    let paginationArgs;
    try {
      paginationArgs = buildPaginationArgs(parsedQuery.data);
    } catch {
      return res.status(400).json({ error: "Invalid cursor" });
    }

    const issues = await prisma.issue.findMany({
      where: { organizationId: req.organizationId! },
      include: { assignee: { select: { id: true, name: true } } },
      ...paginationArgs,
    });

    const { data, hasNextPage, nextCursor } = paginateResults(
      issues,
      parsedQuery.data.limit,
    );

    res.json({ data, hasNextPage, nextCursor });
  },
);

router.get(
  "/organizations/:organizationId/projects/:projectId/issues",
  resolveOrgFromParam("organizationId"),
  requireRole("VIEWER"),
  async (req: OrgScopedRequest, res) => {
    const projectId = req.params.projectId;

    if (typeof projectId !== "string") {
      return res.status(400).json({ error: "Invalid project id" });
    }

    const parsedQuery = paginationQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({ error: parsedQuery.error.flatten() });
    }

    let paginationArgs;
    try {
      paginationArgs = buildPaginationArgs(parsedQuery.data);
    } catch {
      return res.status(400).json({ error: "Invalid cursor" });
    }

    const issues = await prisma.issue.findMany({
      where: {
        organizationId: req.organizationId!,
        projectId,
      },
      include: {
        assignee: {
          select: { id: true, name: true },
        },
      },
      ...paginationArgs,
    });

    const { data, hasNextPage, nextCursor } = paginateResults(
      issues,
      parsedQuery.data.limit,
    );

    res.json({ data, hasNextPage, nextCursor });
  },
);

export default router;
