import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireRole, OrgScopedRequest } from "../middleware/requireRole";
import {
  resolveOrgFromParam,
  resolveOrgFromMeeting,
} from "../lib/resolveOrgContext";
import { paginationQuerySchema, MAX_PAGE_SIZE } from "../lib/pagination";
import { logActivity, ActivityAction } from "../lib/activityLog";
import { notify, notifyMany, NotificationType } from "../lib/notifications";
import {
  generateOccurrences,
  MAX_RECURRING_OCCURRENCES,
} from "../lib/meetingRecurrence";

const router = Router();
router.use(requireAuth);

const MEETING_KINDS = [
  "STANDUP",
  "SPRINT_PLANNING",
  "DESIGN_REVIEW",
  "BACKEND_SYNC",
  "DEMO",
  "RETROSPECTIVE",
  "ONE_ON_ONE",
  "INCIDENT_REVIEW",
  "OTHER",
] as const;

const RECURRENCE_RULES = ["NONE", "DAILY", "WEEKDAYS", "WEEKLY"] as const;
const RSVP_STATUSES = ["ACCEPTED", "DECLINED", "TENTATIVE"] as const;

// Shared response shape for a single meeting, including everything the
// detail page and the meeting-list page need — attendees (with RSVP
// status), linked issues, and the creator. Kept as one function so the
// create/list/get/patch/rsvp handlers below can't drift from each other.
function meetingInclude() {
  return {
    createdBy: { select: { id: true, name: true } },
    project: { select: { id: true, name: true } },
    attendees: {
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" as const },
    },
    linkedIssues: {
      include: {
        issue: {
          select: {
            id: true,
            title: true,
            status: true,
            priority: true,
            projectId: true,
          },
        },
      },
    },
  };
}

async function assertOrgMembers(
  organizationId: string,
  userIds: string[],
): Promise<boolean> {
  if (userIds.length === 0) return true;
  const count = await prisma.membership.count({
    where: { organizationId, userId: { in: userIds } },
  });
  return count === userIds.length;
}

async function assertOrgIssues(
  organizationId: string,
  issueIds: string[],
): Promise<boolean> {
  if (issueIds.length === 0) return true;
  const count = await prisma.issue.count({
    where: { organizationId, id: { in: issueIds } },
  });
  return count === issueIds.length;
}

const createMeetingSchema = z.object({
  title: z.string().min(1).max(200),
  kind: z.enum(MEETING_KINDS).optional(),
  description: z.string().max(5000).optional(),
  startsAt: z.string().datetime(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  location: z.string().max(500).optional(),
  projectId: z.string().uuid().nullable().optional(),
  attendeeUserIds: z.array(z.string().uuid()).max(200).optional(),
  linkedIssueIds: z.array(z.string().uuid()).max(50).optional(),
  recurrenceRule: z.enum(RECURRENCE_RULES).optional(),
  // Only relevant when recurrenceRule !== NONE. Ignored otherwise.
  occurrenceCount: z
    .number()
    .int()
    .min(1)
    .max(MAX_RECURRING_OCCURRENCES)
    .optional(),
});

// POST /api/organizations/:organizationId/meetings
// Creates one meeting, or (when recurrenceRule is set) a whole series of
// concrete Meeting rows sharing one seriesId. MEMBER and above — mirrors
// projects.ts's "MEMBER can create" convention.
router.post(
  "/organizations/:organizationId/meetings",
  resolveOrgFromParam("organizationId"),
  requireRole("MEMBER"),
  async (req: OrgScopedRequest, res) => {
    const parsed = createMeetingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const data = parsed.data;
    const organizationId = req.organizationId!;

    if (data.projectId) {
      const project = await prisma.project.findUnique({
        where: { id: data.projectId },
      });
      if (!project || project.organizationId !== organizationId) {
        return res.status(404).json({ error: "Project not found" });
      }
    }

    // Defense in depth, same reasoning as issues.ts's projectId check:
    // a client could pass another org's user/issue ids alongside a valid
    // organizationId in the URL. Reject rather than silently drop them.
    const attendeeUserIds = Array.from(
      new Set([req.userId!, ...(data.attendeeUserIds ?? [])]),
    );
    if (!(await assertOrgMembers(organizationId, attendeeUserIds))) {
      return res
        .status(400)
        .json({
          error: "One or more attendees are not members of this organization",
        });
    }

    const linkedIssueIds = data.linkedIssueIds ?? [];
    if (!(await assertOrgIssues(organizationId, linkedIssueIds))) {
      return res
        .status(400)
        .json({
          error: "One or more issues do not belong to this organization",
        });
    }

    const rule = data.recurrenceRule ?? "NONE";
    const occurrences = generateOccurrences(
      new Date(data.startsAt),
      rule,
      rule === "NONE" ? 1 : (data.occurrenceCount ?? 1),
    );
    const seriesId = rule === "NONE" ? null : randomUUID();

    const created = await prisma.$transaction(
      occurrences.map((startsAt) =>
        prisma.meeting.create({
          data: {
            title: data.title,
            kind: data.kind ?? "OTHER",
            description: data.description,
            startsAt,
            durationMinutes: data.durationMinutes ?? 30,
            location: data.location,
            recurrenceRule: rule,
            seriesId,
            organizationId,
            projectId: data.projectId ?? null,
            createdById: req.userId!,
            attendees: {
              create: attendeeUserIds.map((userId) => ({
                userId,
                // The organizer is auto-accepted; everyone else starts
                // as invited and RSVPs themselves via PATCH .../rsvp.
                status: userId === req.userId ? "ACCEPTED" : "INVITED",
                respondedAt: userId === req.userId ? new Date() : null,
              })),
            },
            linkedIssues: {
              create: linkedIssueIds.map((issueId) => ({ issueId })),
            },
          },
          include: meetingInclude(),
        }),
      ),
    );

    await logActivity({
      organizationId,
      userId: req.userId!,
      action: ActivityAction.MEETING_CREATED,
      metadata: {
        title: data.title,
        meetingIds: created.map((m) => m.id),
        recurrenceRule: rule,
        occurrenceCount: created.length,
      },
    });

    // Notify everyone invited (excluding the organizer) about the first
    // occurrence only — a 52-notification blast for a recurring series
    // would drown out everything else in someone's feed.
    await notifyMany(
      attendeeUserIds,
      {
        organizationId,
        type: NotificationType.ORG_EVENT,
        message: `invited you to "${data.title}"`,
        actorId: req.userId!,
      },
      req.userId!,
    );

    res.status(201).json(rule === "NONE" ? created[0] : { series: created });
  },
);

const listMeetingsQuerySchema = paginationQuerySchema.extend({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  projectId: z.string().uuid().optional(),
});

// GET /api/organizations/:organizationId/meetings?from=&to=&projectId=&limit=
// Simple offset-free "give me everything in this date range" list, ordered
// by startsAt ascending. Deliberately not cursor-paginated like
// projects/issues/decisions: those use createdAt-ordered cursors because
// their natural sort key IS insertion order, but meetings are sorted by
// startsAt (a value the client itself can set arbitrarily), and the
// per-org meeting volume this generator can produce is bounded
// (MAX_RECURRING_OCCURRENCES=52 per series) — a plain LIMIT is sufficient
// and doesn't need cursor machinery built for a much larger-volume case.
router.get(
  "/organizations/:organizationId/meetings",
  resolveOrgFromParam("organizationId"),
  requireRole("VIEWER"),
  async (req: OrgScopedRequest, res) => {
    const parsedQuery = listMeetingsQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({ error: parsedQuery.error.flatten() });
    }
    const { from, to, projectId, limit } = parsedQuery.data;

    const meetings = await prisma.meeting.findMany({
      where: {
        organizationId: req.organizationId!,
        ...(projectId ? { projectId } : {}),
        ...(from || to
          ? {
              startsAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lt: new Date(to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { startsAt: "asc" },
      take: Math.min(limit, MAX_PAGE_SIZE),
      include: meetingInclude(),
    });

    res.json({ data: meetings });
  },
);

// GET /api/meetings/:meetingId
router.get(
  "/meetings/:meetingId",
  resolveOrgFromMeeting,
  requireRole("VIEWER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const meetingId = req.params.meetingId as string;
    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      include: meetingInclude(),
    });
    if (!meeting) return res.status(404).json({ error: "Not found" });
    res.json(meeting);
  },
);

const updateMeetingSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  kind: z.enum(MEETING_KINDS).optional(),
  description: z.string().max(5000).nullable().optional(),
  startsAt: z.string().datetime().optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  location: z.string().max(500).nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
});

// PATCH /api/meetings/:meetingId
// Only the creator or a MANAGER+ can edit — mirrors decisions.ts's
// author-or-admin convention, using MANAGER as the org-side override
// since meetings are an operational/scheduling concern, not a policy one.
router.patch(
  "/meetings/:meetingId",
  resolveOrgFromMeeting,
  requireRole("MEMBER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const meetingId = req.params.meetingId as string;
    const parsed = updateMeetingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const existing = await prisma.meeting.findUnique({
      where: { id: meetingId },
    });
    if (!existing) return res.status(404).json({ error: "Not found" });

    const isCreator = existing.createdById === req.userId;
    const isManagerPlus =
      req.membershipRole === "MANAGER" || req.membershipRole === "ADMIN";
    if (!isCreator && !isManagerPlus) {
      return res
        .status(403)
        .json({
          error: "Only the organizer or a manager can edit this meeting",
        });
    }

    if (parsed.data.projectId) {
      const project = await prisma.project.findUnique({
        where: { id: parsed.data.projectId },
      });
      if (!project || project.organizationId !== req.organizationId) {
        return res.status(404).json({ error: "Project not found" });
      }
    }

    const updated = await prisma.meeting.update({
      where: { id: meetingId },
      data: {
        ...parsed.data,
        startsAt: parsed.data.startsAt
          ? new Date(parsed.data.startsAt)
          : undefined,
      },
      include: meetingInclude(),
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.MEETING_UPDATED,
      metadata: { meetingId: updated.id, ...parsed.data },
    });

    res.json(updated);
  },
);

// DELETE /api/meetings/:meetingId?scope=series
// scope=series also deletes every other, still-upcoming meeting sharing
// the same seriesId (e.g. cancelling the rest of a recurring standup) —
// past occurrences in the series are left alone since they already
// happened and may carry real notes/attendance history.
router.delete(
  "/meetings/:meetingId",
  resolveOrgFromMeeting,
  requireRole("MEMBER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const meetingId = req.params.meetingId as string;
    const existing = await prisma.meeting.findUnique({
      where: { id: meetingId },
    });
    if (!existing) return res.status(404).json({ error: "Not found" });

    const isCreator = existing.createdById === req.userId;
    const isManagerPlus =
      req.membershipRole === "MANAGER" || req.membershipRole === "ADMIN";
    if (!isCreator && !isManagerPlus) {
      return res
        .status(403)
        .json({
          error: "Only the organizer or a manager can delete this meeting",
        });
    }

    const scope = req.query.scope === "series" ? "series" : "single";

    if (scope === "series" && existing.seriesId) {
      await prisma.meeting.deleteMany({
        where: {
          seriesId: existing.seriesId,
          organizationId: req.organizationId!,
          startsAt: { gte: new Date() },
        },
      });
    } else {
      await prisma.meeting.delete({ where: { id: existing.id } });
    }

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.MEETING_DELETED,
      metadata: { meetingId: existing.id, scope },
    });

    res.status(204).send();
  },
);

const rsvpSchema = z.object({ status: z.enum(RSVP_STATUSES) });

// PATCH /api/meetings/:meetingId/rsvp
// Any authenticated org member can RSVP — including responding to a
// meeting they weren't explicitly invited to (self-adding as TENTATIVE),
// which upserts an attendee row rather than requiring the organizer to
// have pre-invited every possible attendee.
router.patch(
  "/meetings/:meetingId/rsvp",
  resolveOrgFromMeeting,
  requireRole("VIEWER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const meetingId = req.params.meetingId as string;
    const parsed = rsvpSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const attendee = await prisma.meetingAttendee.upsert({
      where: {
        meetingId_userId: {
          meetingId,
          userId: req.userId!,
        },
      },
      update: { status: parsed.data.status, respondedAt: new Date() },
      create: {
        meetingId,
        userId: req.userId!,
        status: parsed.data.status,
        respondedAt: new Date(),
      },
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.MEETING_RSVP,
      metadata: { meetingId, status: parsed.data.status },
    });

    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      select: { title: true, createdById: true },
    });
    if (meeting && meeting.createdById !== req.userId) {
      await notify({
        recipientId: meeting.createdById,
        organizationId: req.organizationId!,
        type: NotificationType.ORG_EVENT,
        message: `RSVP'd ${parsed.data.status.toLowerCase()} to "${meeting.title}"`,
        actorId: req.userId!,
      });
    }

    res.json(attendee);
  },
);

const notesSchema = z.object({ notes: z.string().max(20000).nullable() });

// PATCH /api/meetings/:meetingId/notes
// Any attendee (or the organizer) can add/edit minutes after the meeting
// happens — deliberately not restricted to just the creator, since
// whoever takes notes in a real meeting usually isn't the organizer.
router.patch(
  "/meetings/:meetingId/notes",
  resolveOrgFromMeeting,
  requireRole("VIEWER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const meetingId = req.params.meetingId as string;
    const parsed = notesSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const meetingWithAttendees = await prisma.meeting.findUnique({
      where: { id: meetingId },
      include: { attendees: { select: { userId: true } } },
    });
    if (!meetingWithAttendees)
      return res.status(404).json({ error: "Not found" });

    const isAttendee = meetingWithAttendees.attendees.some(
      (a: { userId: string }) => a.userId === req.userId,
    );
    const isCreator = meetingWithAttendees.createdById === req.userId;
    if (!isAttendee && !isCreator) {
      return res
        .status(403)
        .json({ error: "Only attendees can add notes to this meeting" });
    }

    const updated = await prisma.meeting.update({
      where: { id: meetingId },
      data: { notes: parsed.data.notes },
      include: meetingInclude(),
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.MEETING_NOTES_UPDATED,
      metadata: { meetingId: updated.id },
    });

    res.json(updated);
  },
);

const linkIssueSchema = z.object({ issueId: z.string().uuid() });

// POST /api/meetings/:meetingId/issues
// The core "connect a task/issue to a meeting" capability that didn't
// exist before this milestone.
router.post(
  "/meetings/:meetingId/issues",
  resolveOrgFromMeeting,
  requireRole("MEMBER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const meetingId = req.params.meetingId as string;
    const parsed = linkIssueSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const issue = await prisma.issue.findUnique({
      where: { id: parsed.data.issueId },
    });
    if (!issue || issue.organizationId !== req.organizationId) {
      return res.status(404).json({ error: "Issue not found" });
    }

    const link = await prisma.meetingLinkedIssue.upsert({
      where: {
        meetingId_issueId: {
          meetingId,
          issueId: parsed.data.issueId,
        },
      },
      update: {},
      create: { meetingId, issueId: parsed.data.issueId },
      include: {
        issue: {
          select: { id: true, title: true, status: true, priority: true },
        },
      },
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.MEETING_ISSUE_LINKED,
      issueId: parsed.data.issueId,
      metadata: { meetingId },
    });

    res.status(201).json(link);
  },
);

// DELETE /api/meetings/:meetingId/issues/:issueId
router.delete(
  "/meetings/:meetingId/issues/:issueId",
  resolveOrgFromMeeting,
  requireRole("MEMBER", { notFoundIfNoMembership: true }),
  async (req: OrgScopedRequest, res) => {
    const meetingId = req.params.meetingId as string;
    const issueId = req.params.issueId as string;

    await prisma.meetingLinkedIssue.deleteMany({
      where: { meetingId, issueId },
    });

    await logActivity({
      organizationId: req.organizationId!,
      userId: req.userId!,
      action: ActivityAction.MEETING_ISSUE_UNLINKED,
      issueId,
      metadata: { meetingId },
    });

    res.status(204).send();
  },
);

export default router;
