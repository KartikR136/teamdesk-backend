import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole, OrgScopedRequest } from "../middleware/requireRole";
import { resolveOrgFromParam } from "../lib/resolveOrgContext";
import {
  paginationQuerySchema,
  buildPaginationArgs,
  paginateResults,
} from "../lib/pagination";
import { logActivity, ActivityAction } from "../lib/activityLog";

const router = Router();
router.use(requireAuth);

/**
 * Sprints — Quick Actions milestone. Same shape/conventions as
 * projects.ts and decisions.ts: nested-under-org create/list, plus a
 * flat /sprints/:sprintId for get/update/status since the client only
 * ever has the sprint's own id at that point (mirrors resolveOrgFromIssue's
 * reasoning).
 */

const createSprintSchema = z
  .object({
    name: z.string().min(1),
    goal: z.string().optional(),
    projectId: z.string().uuid(),
    startDate: z.string().datetime(),
    endDate: z.string().datetime(),
  })
  .refine((data) => new Date(data.endDate) > new Date(data.startDate), {
    message: "endDate must be after startDate",
    path: ["endDate"],
  });

router.post(
  "/organizations/:organizationId/sprints",
  resolveOrgFromParam("organizationId"),
  requireRole("MEMBER"),
  async (req: OrgScopedRequest, res) => {
    const parsed = createSprintSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });

    // Defense in depth, same reasoning as issues.ts's create route: verify
    // the target project actually belongs to the SAME org before trusting
    // a client-supplied projectId, rather than relying solely on the
    // requireRole check above (which only proves membership in *an* org).
    const project = await prisma.project.findUnique({
      where: { id: parsed.data.projectId },
    });
    if (!project || project.organizationId !== req.organizationId) {
      return res.status(404).json({ error: "Project not found" });
    }

    const sprint = await prisma.sprint.create({
      data: {
        name: parsed.data.name,
        goal: parsed.data.goal,
        projectId: parsed.data.projectId,
        organizationId: req.organizationId!,
        createdById: req.userId!,
        startDate: new Date(parsed.data.startDate),
        endDate: new Date(parsed.data.endDate),
      },
      include: {
        project: { select: { id: true, name: true } },
        _count: { select: { issues: true } },
      },
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.SPRINT_CREATED,
      metadata: { sprintId: sprint.id, name: sprint.name, projectId: sprint.projectId },
    });

    res.status(201).json(sprint);
  },
);

router.get(
  "/organizations/:organizationId/sprints",
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

    // Optional ?projectId= narrows to a single project's sprints (e.g. the
    // project detail page's sprint picker) without needing a second route.
    const projectId =
      typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const status =
      typeof req.query.status === "string" &&
      ["PLANNED", "ACTIVE", "COMPLETED"].includes(req.query.status)
        ? (req.query.status as "PLANNED" | "ACTIVE" | "COMPLETED")
        : undefined;

    const sprints = await prisma.sprint.findMany({
      where: {
        organizationId: req.organizationId!,
        ...(projectId ? { projectId } : {}),
        ...(status ? { status } : {}),
      },
      include: {
        project: { select: { id: true, name: true } },
        _count: { select: { issues: true } },
      },
      ...paginationArgs,
    });

    const { data, hasNextPage, nextCursor } = paginateResults(
      sprints,
      parsedQuery.data.limit,
    );

    res.json({ data, hasNextPage, nextCursor });
  },
);

// GET a single sprint plus its issues + completion stats — powers the
// sprint detail page in one round trip, same reasoning as
// GET /issues/:issueId returning comments inline.
router.get(
  "/sprints/:sprintId",
  async (req: OrgScopedRequest, res, next) => {
    const sprintId = req.params.sprintId;
    if (typeof sprintId !== "string") {
      return res.status(400).json({ error: "Invalid sprint id" });
    }
    const sprint = await prisma.sprint.findUnique({
      where: { id: sprintId },
      select: { organizationId: true },
    });
    if (!sprint) return res.status(404).json({ error: "Sprint not found" });
    req.organizationId = sprint.organizationId;
    next();
  },
  requireRole("VIEWER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const sprintId = req.params.sprintId as string;

    const sprint = await prisma.sprint.findUnique({
      where: { id: sprintId },
      include: {
        project: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        issues: {
          orderBy: { createdAt: "desc" },
          include: { assignee: { select: { id: true, name: true } } },
        },
      },
    });

    if (!sprint) return res.status(404).json({ error: "Sprint not found" });

    const total = sprint.issues.length;
    const done = sprint.issues.filter((i) => i.status === "DONE").length;
    const totalPoints = sprint.issues.reduce(
      (sum, i) => sum + (i.estimatePoints ?? 0),
      0,
    );
    const donePoints = sprint.issues
      .filter((i) => i.status === "DONE")
      .reduce((sum, i) => sum + (i.estimatePoints ?? 0), 0);

    res.json({
      ...sprint,
      progress: {
        totalIssues: total,
        doneIssues: done,
        percentComplete: total === 0 ? 0 : Math.round((done / total) * 100),
        totalPoints,
        donePoints,
      },
    });
  },
);

const updateSprintSchema = z.object({
  name: z.string().min(1).optional(),
  goal: z.string().nullable().optional(),
  status: z.enum(["PLANNED", "ACTIVE", "COMPLETED"]).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

router.patch(
  "/sprints/:sprintId",
  async (req: OrgScopedRequest, res, next) => {
    const sprintId = req.params.sprintId;
    if (typeof sprintId !== "string") {
      return res.status(400).json({ error: "Invalid sprint id" });
    }
    const sprint = await prisma.sprint.findUnique({
      where: { id: sprintId },
      select: { organizationId: true },
    });
    if (!sprint) return res.status(404).json({ error: "Sprint not found" });
    req.organizationId = sprint.organizationId;
    next();
  },
  requireRole("MEMBER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const parsed = updateSprintSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });

    const sprintId = req.params.sprintId as string;
    const before = await prisma.sprint.findUnique({
      where: { id: sprintId },
      select: { status: true },
    });

    const updated = await prisma.sprint.update({
      where: { id: sprintId },
      data: {
        ...parsed.data,
        startDate: parsed.data.startDate
          ? new Date(parsed.data.startDate)
          : undefined,
        endDate: parsed.data.endDate ? new Date(parsed.data.endDate) : undefined,
      },
      include: {
        project: { select: { id: true, name: true } },
        _count: { select: { issues: true } },
      },
    });

    if (parsed.data.status && before && parsed.data.status !== before.status) {
      await logActivity({
        organizationId: req.organizationId!,
        userId: req.userId!,
        action: ActivityAction.SPRINT_STATUS_CHANGED,
        metadata: { sprintId: updated.id, status: updated.status },
      });
    } else {
      await logActivity({
        organizationId: req.organizationId!,
        userId: req.userId!,
        action: ActivityAction.SPRINT_UPDATED,
        metadata: { sprintId: updated.id, ...parsed.data },
      });
    }

    res.json(updated);
  },
);

export default router;
