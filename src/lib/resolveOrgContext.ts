import { Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { OrgScopedRequest } from "../middleware/requireRole";

// Resolves organizationId for routes scoped directly by :organizationId in the URL,
// e.g. GET /api/organizations/:organizationId/projects
// Still goes through requireRole afterward — this only sets context, doesn't authorize.
export function resolveOrgFromParam(paramName = "organizationId") {
  return (req: OrgScopedRequest, _res: Response, next: NextFunction) => {
    const value = req.params[paramName];

    if (typeof value !== "string") {
      return next(new Error("Invalid organizationId"));
    }

    req.organizationId = value;
    next();
  };
}

// Resolves organizationId by looking up the Issue's stored organizationId directly —
// this is the case from your reasoning: client only sends :issueId, server derives org.
export async function resolveOrgFromIssue(
  req: OrgScopedRequest,
  res: Response,
  next: NextFunction,
) {
  const issueId = req.params.issueId;

  if (typeof issueId !== "string") {
    return res.status(400).json({ error: "Invalid issue id" });
  }

  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: { organizationId: true },
  });

  if (!issue) {
    return res.status(404).json({ error: "Issue not found" });
  }

  req.organizationId = issue.organizationId;
  next();
}

// Same pattern for Project-scoped routes.
export async function resolveOrgFromProject(
  req: OrgScopedRequest,
  res: Response,
  next: NextFunction,
) {
  const projectId = req.params.projectId;

  if (typeof projectId !== "string") {
    return res.status(400).json({ error: "Invalid project id" });
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true },
  });

  if (!project) {
    return res.status(404).json({ error: "Project not found" });
  }

  req.organizationId = project.organizationId;
  next();
}

// Same pattern for Comment-scoped routes (edit/delete a single comment).
// Derives org via Comment -> Issue -> organizationId, mirroring how
// resolveOrgFromIssue never trusts a client-supplied organizationId.
export async function resolveOrgFromComment(
  req: OrgScopedRequest,
  res: Response,
  next: NextFunction,
) {
  const commentId = req.params.commentId;

  if (typeof commentId !== "string") {
    return res.status(400).json({ error: "Invalid comment id" });
  }

  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { issue: { select: { organizationId: true } } },
  });

  if (!comment) {
    return res.status(404).json({ error: "Comment not found" });
  }

  req.organizationId = comment.issue.organizationId;
  next();
}

// Same pattern for Decision Log-scoped routes (get/edit/delete a single
// decision). organizationId is denormalized directly onto DecisionLog
// (same convention as Issue/Project/ActivityLog — see ARCHITECTURE.md),
// so this is a direct lookup, not a join through another resource.
export async function resolveOrgFromDecision(
  req: OrgScopedRequest,
  res: Response,
  next: NextFunction,
) {
  const decisionId = req.params.decisionId;

  if (typeof decisionId !== "string") {
    return res.status(400).json({ error: "Invalid decision id" });
  }

  const decision = await prisma.decisionLog.findUnique({
    where: { id: decisionId },
    select: { organizationId: true },
  });

  if (!decision) {
    return res.status(404).json({ error: "Decision not found" });
  }

  req.organizationId = decision.organizationId;
  next();
}
