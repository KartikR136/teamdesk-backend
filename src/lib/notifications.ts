import { prisma } from "./prisma";
import { redis } from "./redis";
import { isInAppEnabled } from "./notificationPreferences";
import { NotificationType, NotificationTypeValue } from "./notificationTypes";

// Re-exported so nothing importing `{ NotificationType }` from
// "./notifications" (every existing route -- issues.ts, comments.ts,
// deployments.ts, etc.) needs to change its import path. The actual
// declaration now lives in notificationTypes.ts to avoid a circular
// import with notificationPreferences.ts (see that file's top comment).
export { NotificationType, NotificationTypeValue };

interface NotifyParams {
  recipientId: string;
  organizationId: string;
  type: NotificationTypeValue;
  message: string;
  issueId?: string;
  pullRequestId?: string;
  deploymentId?: string;
  buildRunId?: string;
  // Who caused this notification (e.g. who made the assignment/comment/
  // status change) -- distinct from recipientId, and needed for the
  // dashboard's `actorName` field. Optional because not every notification
  // has a clear human actor (none currently, but kept optional for future
  // system-generated notifications).
  actorId?: string;
}

// Channel used for real-time delivery (see routes/notifications.ts's SSE
// stream). One channel per recipient rather than one global channel -- the
// stream handler only ever needs to subscribe to the single channel for
// the connected user, instead of subscribing to everything and filtering
// client-side, which would leak every user's notification traffic into
// every open connection.
export function notificationChannel(userId: string): string {
  return `notifications:${userId}`;
}

// Same reasoning as logActivity: called explicitly at the end of a
// mutation's route handler, swallows its own errors so a failure to write
// a notification never fails or rolls back the mutation that triggered it.
// A notification is a side effect of the real action, not part of it.
export async function notify(params: NotifyParams): Promise<void> {
  try {
    // Respect the recipient's own in-app preference for this notification
    // type. Checked here (not at the route layer) so every call site --
    // present and future -- gets this for free without remembering to add
    // the check itself.
    const enabled = await isInAppEnabled(params.recipientId, params.type);
    if (!enabled) return;

    const created = await prisma.notification.create({
      data: {
        recipientId: params.recipientId,
        organizationId: params.organizationId,
        type: params.type,
        message: params.message,
        issueId: params.issueId,
        pullRequestId: params.pullRequestId,
        deploymentId: params.deploymentId,
        buildRunId: params.buildRunId,
        actorId: params.actorId,
      },
      include: { actor: { select: { name: true } } },
    });

    // Best-effort real-time push. A subscriber (the SSE route) may or may
    // not be connected right now -- publishing when nobody's listening is a
    // harmless no-op in Redis pub/sub, which is exactly the fire-and-forget
    // semantics we want here: the row in Postgres is the durable source of
    // truth, this is purely a "wake up and refetch" nudge for open tabs.
    await redis
      .publish(
        notificationChannel(params.recipientId),
        JSON.stringify({
          id: created.id,
          type: created.type,
          message: created.message,
          actorName: created.actor?.name ?? "System",
          createdAt: created.createdAt.toISOString(),
          read: created.read,
        }),
      )
      .catch((err) => {
        console.error("Failed to publish notification event:", err);
      });
  } catch (err) {
    console.error("Failed to write notification:", err);
  }
}

// Convenience for notifying several recipients at once (e.g. everyone in
// an org for an ORG_EVENT), deliberately excluding a given user (typically
// the actor themself -- you don't need a notification telling you about
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
