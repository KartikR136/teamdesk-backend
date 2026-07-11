import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole, OrgScopedRequest } from "../middleware/requireRole";
import { resolveOrgFromParam } from "../lib/resolveOrgContext";
import {
  paginationQuerySchema,
  buildPaginationArgs,
  paginateResults,
} from "../lib/pagination";

const router = Router();
router.use(requireAuth);

// GET /api/organizations/:organizationId/activity
// Any org member (VIEWER and above) can read the activity feed — same
// visibility level as reading issues/projects. Same cursor-pagination
// pattern as M1's issues/projects lists, reusing the shared helper rather
// than writing a parallel implementation.
router.get(
  "/organizations/:organizationId/activity",
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

    const logs = await prisma.activityLog.findMany({
      where: { organizationId: req.organizationId! },
      include: {
        user: { select: { id: true, name: true } },
      },
      ...paginationArgs,
    });

    const { data, hasNextPage, nextCursor } = paginateResults(
      logs,
      parsedQuery.data.limit,
    );

    res.json({ data, hasNextPage, nextCursor });
  },
);

export default router;
