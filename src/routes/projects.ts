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

const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

// Nested under an org: POST /api/organizations/:organizationId/projects
router.post(
  "/organizations/:organizationId/projects",
  resolveOrgFromParam("organizationId"),
  requireRole("MEMBER"), // MEMBER and above can create projects
  async (req: OrgScopedRequest, res) => {
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });

    const project = await prisma.project.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description,
        organizationId: req.organizationId!,
      },
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.PROJECT_CREATED,
      metadata: { projectId: project.id, name: project.name },
    });

    res.status(201).json(project);
  },
);

router.get(
  "/organizations/:organizationId/projects",
  resolveOrgFromParam("organizationId"),
  requireRole("VIEWER"), // any member can view
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

    const projects = await prisma.project.findMany({
      where: { organizationId: req.organizationId! },
      ...paginationArgs,
    });

    const { data, hasNextPage, nextCursor } = paginateResults(
      projects,
      parsedQuery.data.limit,
    );

    res.json({ data, hasNextPage, nextCursor });
  },
);

export default router;
