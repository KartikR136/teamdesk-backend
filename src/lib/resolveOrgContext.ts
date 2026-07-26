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
    select: {
      issue: { select: { organizationId: true } },
      pullRequest: { select: { organizationId: true } },
    },
  });

  // This resolver is only ever wired up for the /comments/:commentId
  // routes, which are issue-comment routes exclusively — PR comments use
  // their own resolveOrgFromPullRequestComment (routes/pullRequests.ts).
  // The pullRequest branch here is just defense in depth against a
  // client passing a PR-comment id to the wrong endpoint.
  const organizationId =
    comment?.issue?.organizationId ?? comment?.pullRequest?.organizationId;

  if (!comment || !organizationId) {
    return res.status(404).json({ error: "Comment not found" });
  }

  req.organizationId = organizationId;
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

// Same pattern for Meeting-scoped routes (get/edit/delete/RSVP/link a
// single meeting). organizationId is denormalized directly onto Meeting,
// same convention as Issue/Project/DecisionLog.
export async function resolveOrgFromMeeting(
  req: OrgScopedRequest,
  res: Response,
  next: NextFunction,
) {
  const meetingId = req.params.meetingId;

  if (typeof meetingId !== "string") {
    return res.status(400).json({ error: "Invalid meeting id" });
  }

  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { organizationId: true },
  });

  if (!meeting) {
    return res.status(404).json({ error: "Meeting not found" });
  }

  req.organizationId = meeting.organizationId;
  next();
}

// Same pattern for PullRequest-scoped routes (get/update/merge/close/
// review/link a single pull request). organizationId is denormalized
// directly onto PullRequest, same convention as Meeting/DecisionLog.
export async function resolveOrgFromPullRequest(
  req: OrgScopedRequest,
  res: Response,
  next: NextFunction,
) {
  const pullRequestId = req.params.pullRequestId;

  if (typeof pullRequestId !== "string") {
    return res.status(400).json({ error: "Invalid pull request id" });
  }

  const pullRequest = await prisma.pullRequest.findUnique({
    where: { id: pullRequestId },
    select: { organizationId: true },
  });

  if (!pullRequest) {
    return res.status(404).json({ error: "Pull request not found" });
  }

  req.organizationId = pullRequest.organizationId;
  next();
}

// Same pattern for Deployment-scoped routes (status update, rollback,
// health check) — never trusts a client-supplied organizationId.
export async function resolveOrgFromDeployment(
  req: OrgScopedRequest,
  res: Response,
  next: NextFunction,
) {
  const deploymentId = req.params.deploymentId;

  if (typeof deploymentId !== "string") {
    return res.status(400).json({ error: "Invalid deployment id" });
  }

  const deployment = await prisma.deployment.findUnique({
    where: { id: deploymentId },
    select: { organizationId: true },
  });

  if (!deployment) {
    return res.status(404).json({ error: "Deployment not found" });
  }

  req.organizationId = deployment.organizationId;
  next();
}

// Same pattern for PR-comment-scoped routes (edit/delete a single PR
// comment), mirroring resolveOrgFromComment's Comment -> Issue ->
// organizationId lookup but through PullRequest instead.
export async function resolveOrgFromPullRequestComment(
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
    select: { pullRequest: { select: { organizationId: true } } },
  });

  if (!comment || !comment.pullRequest) {
    return res.status(404).json({ error: "Comment not found" });
  }

  req.organizationId = comment.pullRequest.organizationId;
  next();
}
