import { prisma } from "./prisma";
import { Prisma } from "@prisma/client";

export const ActivityAction = {
  ORGANIZATION_CREATED: "ORGANIZATION_CREATED",
  PROJECT_CREATED: "PROJECT_CREATED",
  ISSUE_CREATED: "ISSUE_CREATED",
  ISSUE_UPDATED: "ISSUE_UPDATED",
  COMMENT_CREATED: "COMMENT_CREATED",
  COMMENT_UPDATED: "COMMENT_UPDATED",
  COMMENT_DELETED: "COMMENT_DELETED",
  MEMBER_INVITED: "MEMBER_INVITED",
  MEMBER_JOINED: "MEMBER_JOINED",
  MEMBER_ROLE_CHANGED: "MEMBER_ROLE_CHANGED",
  MEMBER_REMOVED: "MEMBER_REMOVED",
  // Decision Log — mirrors the ISSUE_* naming convention exactly. Status
  // changes get their own action (not folded into DECISION_UPDATED) since
  // a status transition (e.g. ACCEPTED -> SUPERSEDED) is a distinct,
  // audit-worthy event on this resource in a way a title edit isn't.
  DECISION_CREATED: "DECISION_CREATED",
  DECISION_UPDATED: "DECISION_UPDATED",
  DECISION_STATUS_CHANGED: "DECISION_STATUS_CHANGED",
  DECISION_DELETED: "DECISION_DELETED",
  // Meetings — mirrors the DECISION_* naming convention. RSVP and
  // notes get their own actions (not folded into MEETING_UPDATED) for
  // the same reason DECISION_STATUS_CHANGED is separate from
  // DECISION_UPDATED: they're audit-worthy events in their own right,
  // performed by people other than the meeting's creator.
  MEETING_CREATED: "MEETING_CREATED",
  MEETING_UPDATED: "MEETING_UPDATED",
  MEETING_DELETED: "MEETING_DELETED",
  MEETING_RSVP: "MEETING_RSVP",
  MEETING_NOTES_UPDATED: "MEETING_NOTES_UPDATED",
  MEETING_ISSUE_LINKED: "MEETING_ISSUE_LINKED",
  MEETING_ISSUE_UNLINKED: "MEETING_ISSUE_UNLINKED",
  // Pull Requests — mirrors the MEETING_* convention. Review submissions
  // and merges get their own actions (not folded into PR_UPDATED) for the
  // same reason MEETING_RSVP is separate from MEETING_UPDATED: they're
  // audit-worthy events performed by people other than the PR's author.
  PR_CREATED: "PR_CREATED",
  PR_UPDATED: "PR_UPDATED",
  PR_MERGED: "PR_MERGED",
  PR_CLOSED: "PR_CLOSED",
  PR_REOPENED: "PR_REOPENED",
  PR_REVIEWER_ADDED: "PR_REVIEWER_ADDED",
  PR_REVIEWER_REMOVED: "PR_REVIEWER_REMOVED",
  PR_REVIEW_SUBMITTED: "PR_REVIEW_SUBMITTED",
  PR_COMMENT_CREATED: "PR_COMMENT_CREATED",
  PR_ISSUE_LINKED: "PR_ISSUE_LINKED",
  PR_ISSUE_UNLINKED: "PR_ISSUE_UNLINKED",
  // Deployments — mirrors the PR_* convention. Rollback and health-check
  // updates get their own actions (not folded into DEPLOYMENT_STATUS_
  // CHANGED) for the same audit-worthy-event reasoning as PR_MERGED being
  // separate from PR_UPDATED.
  DEPLOYMENT_CREATED: "DEPLOYMENT_CREATED",
  DEPLOYMENT_STATUS_CHANGED: "DEPLOYMENT_STATUS_CHANGED",
  DEPLOYMENT_ROLLED_BACK: "DEPLOYMENT_ROLLED_BACK",
  DEPLOYMENT_HEALTH_CHECKED: "DEPLOYMENT_HEALTH_CHECKED",
  // Build Health — mirrors the DEPLOYMENT_* convention. PIPELINE_CREATED
  // covers the one-time CI setup step; BUILD_RUN_* covers every
  // individual pipeline execution, whether triggered natively or ingested
  // from a real CI webhook (see routes/buildPipelines.ts).
  BUILD_PIPELINE_CREATED: "BUILD_PIPELINE_CREATED",
  BUILD_PIPELINE_UPDATED: "BUILD_PIPELINE_UPDATED",
  BUILD_PIPELINE_WEBHOOK_ROTATED: "BUILD_PIPELINE_WEBHOOK_ROTATED",
  BUILD_RUN_CREATED: "BUILD_RUN_CREATED",
  BUILD_RUN_INGESTED: "BUILD_RUN_INGESTED",
} as const;

export type ActivityActionType =
  (typeof ActivityAction)[keyof typeof ActivityAction];

interface LogActivityParams {
  organizationId: string;
  userId: string;
  action: ActivityActionType;
  issueId?: string;
  // Additive, optional — mirrors issueId. Existing callers are entirely
  // unaffected since this field is never required.
  decisionId?: string;
  metadata?: Prisma.InputJsonValue;
}
// Called explicitly at the end of each mutation's route handler — not
// triggered by a service layer or DB hook, since this project doesn't have
// (and isn't getting) a service layer to hang it off of. "Automatic" here
// means: it's backend code, not something a client can skip or forge, not
// that it fires without an explicit call site.
//
// Deliberately swallows its own errors rather than rethrowing. An activity
// log entry is an audit trail, not part of the core mutation — a failure to
// write it should never roll back or fail the request that triggered it.
export async function logActivity(params: LogActivityParams): Promise<void> {
  try {
    await prisma.activityLog.create({
      data: {
        organizationId: params.organizationId,
        userId: params.userId,
        action: params.action,
        issueId: params.issueId,
        decisionId: params.decisionId,
        metadata: params.metadata,
      },
    });
  } catch (err) {
    console.error("Failed to write activity log entry:", err);
  }
}
