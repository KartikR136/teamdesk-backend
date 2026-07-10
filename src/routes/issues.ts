import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole, OrgScopedRequest } from "../middleware/requireRole";
import {
  resolveOrgFromParam,
  resolveOrgFromIssue,
} from "../lib/resolveOrgContext";

const router = Router();
router.use(requireAuth);

const createIssueSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  projectId: z.string().uuid(),
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
      },
    });
    res.status(201).json(issue);
  },
);

const updateIssueSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
});

router.patch(
  "/issues/:issueId",
  resolveOrgFromIssue, // derives organizationId from the issue itself — your exact answer, implemented
  requireRole("MEMBER"),
  async (req: OrgScopedRequest, res) => {
    const parsed = updateIssueSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: parsed.error.flatten() });

    const issueId = req.params.issueId;

    if (typeof issueId !== "string") {
      return res.status(400).json({ error: "Invalid issue id" });
    }

    const updated = await prisma.issue.update({
      where: { id: issueId },
      data: parsed.data,
    });
    res.json(updated);
  },
);

router.get(
  "/organizations/:organizationId/issues",
  resolveOrgFromParam("organizationId"),
  requireRole("VIEWER"),
  async (req: OrgScopedRequest, res) => {
    const issues = await prisma.issue.findMany({
      where: { organizationId: req.organizationId! },
      include: { assignee: { select: { id: true, name: true } } },
    });
    res.json(issues);
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
    });
    res.json(issues);
  },
);

export default router;
