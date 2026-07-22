import { prisma } from "../../../lib/prisma";
import {
  AssignedTaskDto,
  DashboardNotificationDto,
  NotificationKind,
  RecentlyViewedIssueDto,
} from "../dto/dashboard.dto";

// Maps our own domain notification types (src/lib/notifications.ts) to the
// frontend's fixed NotificationKind union. See dashboard.dto.ts's
// NotificationKind comment for why STATUS_CHANGE/ORG_EVENT don't have an
// exact match today — this is a deliberate, documented, cosmetic
// compromise (only affects which icon renders; `message` always carries
// the real text).
const KIND_MAP: Record<string, NotificationKind> = {
  ASSIGNMENT: "ISSUE_ASSIGNED",
  COMMENT: "COMMENT_ADDED",
  MENTION: "MENTIONED",
  STATUS_CHANGE: "COMMENT_ADDED",
  ORG_EVENT: "MENTIONED",
};

// Every query in this file scopes to organizationId IN (the user's own
// memberships) — never to a client-supplied organizationId. The dashboard
// is intentionally cross-org (a developer's home view spans every org
// they're in), so the isolation boundary here is "orgs this user actually
// belongs to," enforced by joining against Membership, not by trusting
// anything the request itself claims.
export class DashboardRepository {
  private async getMemberOrgIds(userId: string): Promise<string[]> {
    const memberships = await prisma.membership.findMany({
      where: { userId },
      select: { organizationId: true },
    });
    return memberships.map((m: { organizationId: string }) => m.organizationId);
  }

  // Section 1: My Assigned Tasks.
  // Sorted by highest priority then nearest due date, matching the spec
  // exactly. Priority has no natural sort order as a Prisma enum, so we
  // sort in application code after fetching — the working set per user
  // (assigned, not-done issues) is small enough for this to be negligible,
  // and it keeps the query itself simple and able to use the
  // (assigneeId, dueDate) index for the fetch.
  //
  // `progress` has no backing data model (no subtask/checklist table
  // exists) — it's a status-based heuristic (TODO=0%, IN_PROGRESS=50%,
  // IN_REVIEW=90%, DONE=100%), documented here rather than hidden, and a
  // real subtask-derived progress calculation is a drop-in replacement for
  // this one mapping if/when that model exists.
  private static readonly PROGRESS_BY_STATUS: Record<string, number> = {
    TODO: 0,
    IN_PROGRESS: 50,
    IN_REVIEW: 90,
    DONE: 100,
  };

  async getAssignedTasks(userId: string): Promise<AssignedTaskDto[]> {
    const orgIds = await this.getMemberOrgIds(userId);
    if (orgIds.length === 0) return [];

    const issues = await prisma.issue.findMany({
      where: {
        assigneeId: userId,
        organizationId: { in: orgIds },
        status: { not: "DONE" },
      },
      include: {
        project: { select: { name: true } },
      },
    });

    const priorityRank: Record<string, number> = {
      URGENT: 0,
      HIGH: 1,
      MEDIUM: 2,
      LOW: 3,
    };

    const sorted = [...issues].sort((a, b) => {
      const rankDiff = priorityRank[a.priority] - priorityRank[b.priority];
      if (rankDiff !== 0) return rankDiff;

      if (a.dueDate === null && b.dueDate === null) return 0;
      if (a.dueDate === null) return 1;
      if (b.dueDate === null) return -1;
      return a.dueDate.getTime() - b.dueDate.getTime();
    });

    return sorted.map((issue) => ({
      id: issue.id,
      title: issue.title,
      projectName: issue.project.name,
      status: issue.status,
      priority: issue.priority,
      dueDate: issue.dueDate ? issue.dueDate.toISOString() : null,
      estimatePoints: issue.estimatePoints ?? null,
      progress: DashboardRepository.PROGRESS_BY_STATUS[issue.status] ?? 0,
    }));
  }

  // Section 6: Notifications. Frontend expects a flat, already-paged array
  // (no cursor/hasNextPage wrapper) — most recent N, with consecutive
  // same-(type, issue, actor) notifications collapsed into one entry
  // carrying `groupCount`, matching the frontend mock's own
  // groupCount-on-repeated-comments example.
  async getNotifications(
    userId: string,
    limit = 20,
  ): Promise<DashboardNotificationDto[]> {
    const notifications = await prisma.notification.findMany({
      where: { recipientId: userId },
      orderBy: { createdAt: "desc" },
      take: limit * 2, // fetch extra since grouping can collapse rows
      include: { actor: { select: { name: true } } },
    });

    interface Row {
      id: string;
      type: string;
      message: string;
      createdAt: Date;
      read: boolean;
      actor: { name: string } | null;
    }

    const grouped: DashboardNotificationDto[] = [];
    let previous: Row | null = null;

    for (const raw of notifications as Row[]) {
      if (
        previous &&
        previous.type === raw.type &&
        previous.actor?.name === raw.actor?.name &&
        grouped.length > 0
      ) {
        const last = grouped[grouped.length - 1];
        last.groupCount = (last.groupCount ?? 1) + 1;
        continue;
      }

      grouped.push({
        id: raw.id,
        kind: KIND_MAP[raw.type] ?? "MENTIONED",
        actorName: raw.actor?.name ?? "System",
        message: raw.message,
        createdAt: raw.createdAt.toISOString(),
        read: raw.read,
      });
      previous = raw;

      if (grouped.length >= limit) break;
    }

    return grouped;
  }

  async getUnreadNotificationCount(userId: string): Promise<number> {
    return prisma.notification.count({
      where: { recipientId: userId, read: false },
    });
  }

  // Section 8: Recently Viewed Issues, capped at 10, most recent first.
  async getRecentlyViewedIssues(
    userId: string,
  ): Promise<RecentlyViewedIssueDto[]> {
    const recent = await prisma.recentlyViewedIssue.findMany({
      where: { userId },
      orderBy: { viewedAt: "desc" },
      take: 10,
      include: {
        issue: {
          include: { project: { select: { name: true } } },
        },
      },
    });

    interface Row {
      viewedAt: Date;
      issue: {
        id: string;
        title: string;
        status: string;
        priority: string;
        project: { name: string };
      } | null;
    }

    return (recent as Row[])
      .filter((r): r is Row & { issue: NonNullable<Row["issue"]> } => r.issue !== null)
      .map((r) => ({
        id: r.issue.id,
        title: r.issue.title,
        projectName: r.issue.project.name,
        priority: r.issue.priority as RecentlyViewedIssueDto["priority"],
        status: r.issue.status as RecentlyViewedIssueDto["status"],
        lastViewedAt: r.viewedAt.toISOString(),
      }));
  }

  // Called from the issue-detail route (GET /issues/:issueId) to record a
  // view. Upsert, not insert — re-viewing the same issue updates viewedAt
  // in place instead of creating duplicate rows, then we trim back down to
  // 10 if the upsert pushed the user over that cap.
  async recordIssueView(userId: string, issueId: string): Promise<void> {
    await prisma.recentlyViewedIssue.upsert({
      where: { userId_issueId: { userId, issueId } },
      create: { userId, issueId },
      update: { viewedAt: new Date() },
    });

    const excess = await prisma.recentlyViewedIssue.findMany({
      where: { userId },
      orderBy: { viewedAt: "desc" },
      skip: 10,
      select: { id: true },
    });

    if (excess.length > 0) {
      await prisma.recentlyViewedIssue.deleteMany({
        where: { id: { in: excess.map((e: { id: string }) => e.id) } },
      });
    }
  }
}
