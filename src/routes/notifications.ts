import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth";
import { notificationChannel } from "../lib/notifications";
import {
  getPreferences,
  setPreferences,
  NotificationPreferenceDto,
} from "../lib/notificationPreferences";
import {
  paginationQuerySchema,
  buildPaginationArgs,
  paginateResults,
} from "../lib/pagination";

const router = Router();
router.use(requireAuth);

// All routes here operate on the caller's own notifications (req.userId),
// never a client-supplied recipientId — a notification is a private inbox,
// not an org-scoped resource, so there's no organizationId param to
// resolve/authorize the way other routes do.

const listQuerySchema = paginationQuerySchema.extend({
  unread: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

// GET /api/notifications?limit=&cursor=&unread=true
// Full, cursor-paginated notification history for the current user —
// distinct from GET /api/dashboard/home's top-20 snapshot, which is
// intentionally un-paginated and exists only to feed the dashboard widget.
// This is the backing endpoint for a dedicated "Notification Center" page.
router.get("/notifications", async (req: AuthedRequest, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  let paginationArgs;
  try {
    paginationArgs = buildPaginationArgs(parsed.data);
  } catch {
    return res.status(400).json({ error: "Invalid cursor" });
  }

  const where = {
    recipientId: req.userId!,
    ...(parsed.data.unread !== undefined ? { read: !parsed.data.unread } : {}),
  };

  const rows = await prisma.notification.findMany({
    where,
    include: { actor: { select: { id: true, name: true } } },
    ...paginationArgs,
  });

  const { data, hasNextPage, nextCursor } = paginateResults(
    rows,
    parsed.data.limit,
  );

  res.json({
    data: data.map((n) => ({
      id: n.id,
      type: n.type,
      message: n.message,
      read: n.read,
      createdAt: n.createdAt.toISOString(),
      actorName: n.actor?.name ?? "System",
      issueId: n.issueId,
      pullRequestId: n.pullRequestId,
      deploymentId: n.deploymentId,
      buildRunId: n.buildRunId,
    })),
    hasNextPage,
    nextCursor,
  });
});

// GET /api/notifications/unread-count
// Cheap, standalone endpoint so the header bell can poll/refresh just the
// badge without pulling the full list — same split dashboard.repository.ts
// already makes internally (getNotifications vs getUnreadNotificationCount).
router.get("/notifications/unread-count", async (req: AuthedRequest, res) => {
  const count = await prisma.notification.count({
    where: { recipientId: req.userId!, read: false },
  });
  res.json({ count });
});

// PATCH /api/notifications/:id/read
// Marks a single notification read. Scoped to recipientId in the WHERE
// clause (not just the id) so a user can never mark — or even discover
// the existence of — another user's notification by guessing an id.
router.patch("/notifications/:id/read", async (req: AuthedRequest, res) => {
  const { id } = req.params;
  if (typeof id !== "string") {
    return res.status(400).json({ error: "Invalid notification id" });
  }

  const { count } = await prisma.notification.updateMany({
    where: { id, recipientId: req.userId! },
    data: { read: true },
  });

  if (count === 0) {
    return res.status(404).json({ error: "Notification not found" });
  }

  res.status(204).end();
});

// PATCH /api/notifications/:id/unread
// Symmetric "mark unread" — useful when someone wants to come back to
// something later, same convenience Gmail-style inboxes offer.
router.patch("/notifications/:id/unread", async (req: AuthedRequest, res) => {
  const { id } = req.params;
  if (typeof id !== "string") {
    return res.status(400).json({ error: "Invalid notification id" });
  }

  const { count } = await prisma.notification.updateMany({
    where: { id, recipientId: req.userId! },
    data: { read: false },
  });

  if (count === 0) {
    return res.status(404).json({ error: "Notification not found" });
  }

  res.status(204).end();
});

// POST /api/notifications/read-all
// Bulk mark-all-read, optionally scoped to a single type (e.g. "clear all
// PR_MERGED notifications") so the UI can offer both a global and a
// per-section "mark read" action from the same endpoint.
const readAllBodySchema = z.object({
  type: z.string().optional(),
});
router.post("/notifications/read-all", async (req: AuthedRequest, res) => {
  const parsed = readAllBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { count } = await prisma.notification.updateMany({
    where: {
      recipientId: req.userId!,
      read: false,
      ...(parsed.data.type ? { type: parsed.data.type as never } : {}),
    },
    data: { read: true },
  });

  res.json({ updated: count });
});

// DELETE /api/notifications/:id
// Permanently dismisses a single notification from the inbox.
router.delete("/notifications/:id", async (req: AuthedRequest, res) => {
  const { id } = req.params;
  if (typeof id !== "string") {
    return res.status(400).json({ error: "Invalid notification id" });
  }

  const { count } = await prisma.notification.deleteMany({
    where: { id, recipientId: req.userId! },
  });

  if (count === 0) {
    return res.status(404).json({ error: "Notification not found" });
  }

  res.status(204).end();
});

// GET /api/notifications/preferences
// GET /api/notifications/preferences  -> array of { type, inApp, email }
// PUT /api/notifications/preferences  -> body: array of same shape, upserted
router.get("/notifications/preferences", async (req: AuthedRequest, res) => {
  const prefs = await getPreferences(req.userId!);
  res.json({ data: prefs });
});

const preferenceSchema = z.object({
  type: z.string(),
  inApp: z.boolean(),
  email: z.boolean(),
});
const preferencesBodySchema = z.array(preferenceSchema).max(50);

router.put("/notifications/preferences", async (req: AuthedRequest, res) => {
  const parsed = preferencesBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const updated = await setPreferences(
    req.userId!,
    parsed.data as NotificationPreferenceDto[],
  );
  res.json({ data: updated });
});

// GET /api/notifications/stream
// Server-Sent Events endpoint for real-time delivery. Cookie-authenticated
// (same accessToken cookie as every other route, via requireAuth) — the
// browser's native EventSource can't attach custom headers, but it does
// send cookies when constructed with `{ withCredentials: true }`, which is
// exactly what requireAuth already reads from.
//
// One Redis subscriber connection per open browser tab. That's fine at
// this app's scale; if this ever needs to support thousands of concurrent
// tabs, the standard next step is a single shared subscriber process that
// fans out over an in-process EventEmitter instead of one `redis.duplicate()`
// per connection.
router.get("/notifications/stream", async (req: AuthedRequest, res) => {
  const userId = req.userId!;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Needed because this route sits behind the same CORS setup as the
    // rest of the API (see app.ts) — SSE still goes through a normal CORS
    // preflight/response cycle for cross-origin requests.
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 5000\n\n`);

  const subscriber = redis.duplicate();
  await subscriber.subscribe(notificationChannel(userId));

  subscriber.on("message", (_channel, message) => {
    res.write(`event: notification\ndata: ${message}\n\n`);
  });

  // Heartbeat keeps intermediary proxies/load balancers from silently
  // closing an idle connection, and lets the client detect a dead
  // connection faster than waiting on a TCP timeout.
  const heartbeat = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    subscriber.unsubscribe().catch(() => {});
    subscriber.quit().catch(() => {});
  });
});

export default router;
