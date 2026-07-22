import { prisma } from "../../../../lib/prisma";
import { CodingStatsProvider } from "./CodingStatsProvider";
import { CodingStatsDto } from "../../dto/dashboard.dto";

// Of the five fields in CodingStatsDto, two are computed from real TeamDesk
// data today, three are honest zeros:
//
//   currentStreakDays        REAL — derived from ActivityLog (see below)
//   issuesCompletedThisWeek  REAL — Issues this user completed in the last 7 days
//   reviewsCompletedThisWeek 0    — no PR/code-review model exists yet
//   commitsThisWeek          0    — no VCS integration exists yet
//   focusHoursThisWeek       0    — no time-tracking integration exists yet
//
// Zero, not a fabricated number: this mirrors the original spec's own
// instruction ("if unavailable, return unknown instead of fake data") as
// closely as the frontend's fixed numeric-field contract allows — the
// frontend type has no "unknown" state for these fields, so 0 is the most
// honest value that still satisfies it. Once GitHub/GitLab/time-tracking
// integrations exist, this class is exactly where they plug in.
export class ActivityLogCodingStatsProvider implements CodingStatsProvider {
  readonly name = "activity-log";

  async getStats(userId: string): Promise<CodingStatsDto> {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [currentStreakDays, issuesCompletedThisWeek] = await Promise.all([
      this.computeCurrentStreak(userId),
      prisma.issue.count({
        where: {
          assigneeId: userId,
          status: "DONE",
          updatedAt: { gte: weekAgo },
        },
      }),
    ]);

    return {
      currentStreakDays,
      issuesCompletedThisWeek,
      reviewsCompletedThisWeek: 0,
      commitsThisWeek: 0,
      focusHoursThisWeek: 0,
    };
  }

  private async computeCurrentStreak(userId: string): Promise<number> {
    const activity = await prisma.activityLog.findMany({
      where: { userId },
      select: { createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 2000,
    });

    if (activity.length === 0) return 0;

    const activeDays = new Set<string>(
      activity.map((a: { createdAt: Date }) =>
        a.createdAt.toISOString().slice(0, 10),
      ),
    );
    const sortedDays: string[] = Array.from(activeDays).sort().reverse();

    const today = new Date().toISOString().slice(0, 10);
    const oneDayMs = 24 * 60 * 60 * 1000;
    function daysBetween(a: string, b: string): number {
      return Math.round(
        (new Date(a).getTime() - new Date(b).getTime()) / oneDayMs,
      );
    }

    const gapFromToday = daysBetween(today, sortedDays[0]);
    if (gapFromToday > 1) return 0; // streak broken — most recent activity was more than a day ago

    let streak = 1;
    for (let i = 1; i < sortedDays.length; i++) {
      if (daysBetween(sortedDays[i - 1], sortedDays[i]) === 1) {
        streak++;
      } else {
        break;
      }
    }
    return streak;
  }
}
