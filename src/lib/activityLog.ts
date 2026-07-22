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
