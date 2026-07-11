import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole, OrgScopedRequest } from "../middleware/requireRole";
import {
  resolveOrgFromIssue,
  resolveOrgFromComment,
} from "../lib/resolveOrgContext";
import {
  paginationQuerySchema,
  buildPaginationArgs,
  paginateResults,
} from "../lib/pagination";
import { logActivity, ActivityAction } from "../lib/activityLog";

const router = Router();
router.use(requireAuth);

// Capped at 10k chars — generous for a comment, but an unbounded body field
// lets a single request bloat storage/response payloads indefinitely.
const bodySchema = z.object({
  body: z.string().min(1).max(10000),
});

// POST /api/issues/:issueId/comments
router.post(
  "/issues/:issueId/comments",
  resolveOrgFromIssue,
  requireRole("MEMBER"),
  async (req: OrgScopedRequest, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const issueId = req.params.issueId;
    if (typeof issueId !== "string") {
      return res.status(400).json({ error: "Invalid issue id" });
    }

    const comment = await prisma.comment.create({
      data: {
        body: parsed.data.body,
        issueId,
        authorId: req.userId!,
      },
      include: {
        author: { select: { id: true, name: true } },
      },
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.COMMENT_CREATED,
      issueId,
      metadata: { commentId: comment.id },
    });

    res.status(201).json(comment);
  },
);

// GET /api/issues/:issueId/comments
router.get(
  "/issues/:issueId/comments",
  resolveOrgFromIssue,
  requireRole("VIEWER"),
  async (req: OrgScopedRequest, res) => {
    const issueId = req.params.issueId;
    if (typeof issueId !== "string") {
      return res.status(400).json({ error: "Invalid issue id" });
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

    const comments = await prisma.comment.findMany({
      where: { issueId },
      include: {
        author: { select: { id: true, name: true } },
      },
      ...paginationArgs,
    });

    const { data, hasNextPage, nextCursor } = paginateResults(
      comments,
      parsedQuery.data.limit,
    );

    res.json({ data, hasNextPage, nextCursor });
  },
);

// PATCH /api/comments/:commentId
// Author-only, or ADMIN as a moderation override.
router.patch(
  "/comments/:commentId",
  resolveOrgFromComment,
  requireRole("VIEWER"),
  async (req: OrgScopedRequest, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const commentId = req.params.commentId;
    if (typeof commentId !== "string") {
      return res.status(400).json({ error: "Invalid comment id" });
    }

    const existing = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { authorId: true, issueId: true },
    });

    if (!existing) {
      return res.status(404).json({ error: "Comment not found" });
    }

    const isAuthor = existing.authorId === req.userId;
    const isAdmin = req.membershipRole === "ADMIN";

    if (!isAuthor && !isAdmin) {
      return res
        .status(403)
        .json({
          error: "Only the comment author or an admin can edit this comment",
        });
    }

    const updated = await prisma.comment.update({
      where: { id: commentId },
      data: { body: parsed.data.body },
      include: {
        author: { select: { id: true, name: true } },
      },
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.COMMENT_UPDATED,
      issueId: existing.issueId,
      metadata: { commentId: updated.id },
    });

    res.json(updated);
  },
);

// DELETE /api/comments/:commentId
// Same ownership rule as edit.
router.delete(
  "/comments/:commentId",
  resolveOrgFromComment,
  requireRole("VIEWER"),
  async (req: OrgScopedRequest, res) => {
    const commentId = req.params.commentId;
    if (typeof commentId !== "string") {
      return res.status(400).json({ error: "Invalid comment id" });
    }

    const existing = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { authorId: true, issueId: true },
    });

    if (!existing) {
      return res.status(404).json({ error: "Comment not found" });
    }

    const isAuthor = existing.authorId === req.userId;
    const isAdmin = req.membershipRole === "ADMIN";

    if (!isAuthor && !isAdmin) {
      return res
        .status(403)
        .json({
          error: "Only the comment author or an admin can delete this comment",
        });
    }

    await prisma.comment.delete({ where: { id: commentId } });

    // Logged after the delete succeeds, using the issueId/organizationId
    // captured before the row was removed (the comment itself is gone by
    // the time this runs, so it can't be re-fetched).
    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.COMMENT_DELETED,
      issueId: existing.issueId,
      metadata: { commentId },
    });

    res.status(204).send();
  },
);

export default router;
