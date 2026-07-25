import { prisma } from "../../../../lib/prisma";
import { CalendarProvider } from "./CalendarProvider";
import { MeetingDto } from "../../dto/dashboard.dto";
import { ProviderResult } from "../pullRequest/PullRequestProvider";

// Replaces MockCalendarProvider now that meetings are a first-class,
// native feature (see prisma schema's Meeting model and
// routes/meetings.ts) rather than a placeholder for a future Google/
// Outlook OAuth integration. `integrationRequired` is always false here —
// there IS a working "integration," it's just our own database instead of
// an external calendar. A real external-calendar provider could still be
// added later as an additional source merged alongside this one; the two
// aren't mutually exclusive.
export class NativeMeetingCalendarProvider implements CalendarProvider {
  readonly name = "native";

  async getTodaysMeetings(
    userId: string,
  ): Promise<ProviderResult<MeetingDto>> {
    const memberships = await prisma.membership.findMany({
      where: { userId },
      select: { organizationId: true },
    });
    const orgIds = memberships.map((m) => m.organizationId);
    if (orgIds.length === 0) {
      return { integrationRequired: false, data: [] };
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);

    // "Today's meetings" across every org this user belongs to, and
    // (same reasoning as MeetingAttendee.upsert in routes/meetings.ts)
    // includes meetings the user organizes even if they never added
    // themselves as an explicit attendee row.
    const meetings = await prisma.meeting.findMany({
      where: {
        organizationId: { in: orgIds },
        startsAt: { gte: startOfDay, lt: endOfDay },
        OR: [{ createdById: userId }, { attendees: { some: { userId } } }],
      },
      orderBy: { startsAt: "asc" },
      include: {
        organization: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
        attendees: { select: { userId: true, status: true } },
        _count: { select: { linkedIssues: true } },
      },
    });

    const data: MeetingDto[] = meetings.map((m) => {
      const myAttendance = m.attendees.find((a) => a.userId === userId);
      return {
        id: m.id,
        kind: m.kind,
        title: m.title,
        startsAt: m.startsAt.toISOString(),
        durationMinutes: m.durationMinutes,
        attendeeCount: m.attendees.length,
        organizationId: m.organizationId,
        organizationName: m.organization.name,
        projectId: m.projectId,
        projectName: m.project?.name ?? null,
        location: m.location,
        myRsvpStatus: myAttendance?.status ?? (m.createdById === userId ? "ACCEPTED" : "INVITED"),
        isOrganizer: m.createdById === userId,
        linkedIssueCount: m._count.linkedIssues,
      };
    });

    return { integrationRequired: false, data };
  }
}
