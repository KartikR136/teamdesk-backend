import { prisma } from "./prisma";

export const NotificationType = {
  MENTION: "MENTION",
  COMMENT: "COMMENT",
  ASSIGNMENT: "ASSIGNMENT",
  STATUS_CHANGE: "STATUS_CHANGE",
  ORG_EVENT: "ORG_EVENT",
} as const;

export type NotificationTypeValue =
  (typeof NotificationType)[keyof typeof NotificationType];

interface NotifyParams {
  recipientId: string;
  organizationId: string;
  type: NotificationTypeValue;
  message: string;
  issueId?: string;
  // Who caused this notification (e.g. who made the assignment/comment/
  // status change) — distinct from recipientId, and needed for the
  // dashboard's `actorName` field. Optional because not every notification
  // has a clear human actor (none currently, but kept optional for future
  // system-generated notifications).
  actorId?: string;
}

// Same reasoning as logActivity: called explicitly at the end of a
// mutation's route handler, swallows its own errors so a failure to write
// a notification never fails or rolls back the mutation that triggered it.
// A notification is a side effect of the real action, not part of it.
export async function notify(params: NotifyParams): Promise<void> {
  try {
    await prisma.notification.create({
      data: {
        recipientId: params.recipientId,
        organizationId: params.organizationId,
        type: params.type,
        message: params.message,
        issueId: params.issueId,
        actorId: params.actorId,
      },
    });
  } catch (err) {
    console.error("Failed to write notification:", err);
  }
}

// Convenience for notifying several recipients at once (e.g. everyone in
// an org for an ORG_EVENT), deliberately excluding a given user (typically
// the actor themself — you don't need a notification telling you about
// your own action).
export async function notifyMany(
  recipientIds: string[],
  params: Omit<NotifyParams, "recipientId">,
  excludeUserId?: string,
): Promise<void> {
  const targets = recipientIds.filter((id) => id !== excludeUserId);
  await Promise.all(
    targets.map((recipientId) => notify({ ...params, recipientId })),
  );
}
