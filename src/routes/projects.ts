import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole, OrgScopedRequest } from "../middleware/requireRole";
import { resolveOrgFromParam } from "../lib/resolveOrgContext";

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
    res.status(201).json(project);
  },
);

router.get(
  "/organizations/:organizationId/projects",
  resolveOrgFromParam("organizationId"),
  requireRole("VIEWER"), // any member can view
  async (req: OrgScopedRequest, res) => {
    const projects = await prisma.project.findMany({
      where: { organizationId: req.organizationId! },
    });
    res.json(projects);
  },
);

export default router;
