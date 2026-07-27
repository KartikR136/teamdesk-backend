import crypto from "crypto";
import { prisma } from "../../../lib/prisma";
import {
  AchievementDto,
  CodingStatsDto,
  CodingStreakDetailDto,
  HeatmapCellDto,
  LeaderboardEntryDto,
} from "../dto/dashboard.dto";

const DAY_MS = 24 * 60 * 60 * 1000;
const HEATMAP_DAYS = 90;

// Streak milestones that earn a persisted CodingAchievement row. Mirrors
// the frontend's own MILESTONES constant in CodingStreakCard.tsx — keep
// the two in sync if either changes.
const STREAK_MILESTONES: { days: number; type: string; label: string }[] = [
  { days: 7, type: "STREAK_7", label: "One Week Strong" },
  { days: 14, type: "STREAK_14", label: "Two Week Grind" },
  { days: 30, type: "STREAK_30", label: "Monthly Momentum" },
  { days: 60, type: "STREAK_60", label: "Two Months Deep" },
  { days: 100, type: "STREAK_100", label: "Century Streak" },
  { days: 365, type: "STREAK_365", label: "Full Year" },
];

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / DAY_MS);
}

/**
 * Everything "Coding Streak" needs, in one place. Deliberately separate
 * from CodingStatsProvider (which stays a thin interface implementation
 * feeding the /home aggregate) — this service also backs the dedicated
 * /coding-streak detail endpoints, the public git-push webhook, and the
 * cron-driven freeze maintenance job, none of which belong inside a
 * DashboardService provider.
 */
export class CodingStreakService {
  /** Union of every date this user did something that counts toward a
   * streak: ActivityLog entries, ingested GitCommits, and any date a
   * streak-freeze was spent covering a gap. Pure read — no side effects. */
  private async getActiveDaySet(userId: string): Promise<Set<string>> {
    const [activity, commits, freezes] = await Promise.all([
      prisma.activityLog.findMany({
        where: { userId },
        select: { createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 3000,
      }),
      prisma.gitCommit.findMany({
        where: { userId },
        select: { committedAt: true },
        orderBy: { committedAt: "desc" },
        take: 3000,
      }),
      prisma.streakFreezeUse.findMany({
        where: { userId },
        select: { coveredDate: true },
      }),
    ]);

    const days = new Set<string>();
    for (const a of activity) days.add(toDateKey(a.createdAt));
    for (const c of commits) days.add(toDateKey(c.committedAt));
    for (const f of freezes) days.add(f.coveredDate);
    return days;
  }

  private computeStreakFromDays(activeDays: Set<string>): number {
    if (activeDays.size === 0) return 0;
    const sortedDays = Array.from(activeDays).sort().reverse();
    const today = toDateKey(new Date());

    const gapFromToday = daysBetween(today, sortedDays[0]);
    if (gapFromToday > 1) return 0;

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

  private async recordLongestIfNeeded(userId: string, current: number, existingLongest: number) {
    if (current > existingLongest) {
      await prisma.user.update({
        where: { id: userId },
        data: { longestStreakDays: current },
      });
    }
  }

  /** Idempotent: inserts a CodingAchievement only for milestones this
   * user's current streak has reached and doesn't already have a row
   * for. Safe to call on every read — it's a pure additive insert, same
   * "harmless side effect on a GET" convention as mark-as-read endpoints
   * elsewhere in this codebase. */
  private async awardMilestoneAchievements(userId: string, currentStreak: number) {
    const reached = STREAK_MILESTONES.filter((m) => currentStreak >= m.days);
    if (reached.length === 0) return;

    const existing = await prisma.codingAchievement.findMany({
      where: { userId, type: { in: reached.map((m) => m.type) } },
      select: { type: true },
    });
    const existingTypes = new Set(existing.map((e) => e.type));
    const toCreate = reached.filter((m) => !existingTypes.has(m.type));
    if (toCreate.length === 0) return;

    await prisma.codingAchievement.createMany({
      data: toCreate.map((m) => ({ userId, type: m.type, metadata: { days: m.days } })),
      skipDuplicates: true,
    });
  }

  private weekAgo(): Date {
    return new Date(Date.now() - 7 * DAY_MS);
  }

  /** Real, DB-backed weekly counters. Every field here reflects an actual
   * row in the database — no fabricated numbers. */
  private async getWeeklyCounters(userId: string) {
    const weekAgo = this.weekAgo();
    const [issuesCompletedThisWeek, reviewsCompletedThisWeek, commitsThisWeek, focusMinutes] =
      await Promise.all([
        prisma.issue.count({
          where: { assigneeId: userId, status: "DONE", updatedAt: { gte: weekAgo } },
        }),
        prisma.pullRequestReviewer.count({
          where: {
            userId,
            respondedAt: { gte: weekAgo },
            status: { in: ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"] },
          },
        }),
        prisma.gitCommit.count({ where: { userId, committedAt: { gte: weekAgo } } }),
        prisma.focusSession.aggregate({
          where: { userId, loggedAt: { gte: weekAgo } },
          _sum: { minutes: true },
        }),
      ]);

    return {
      issuesCompletedThisWeek,
      reviewsCompletedThisWeek,
      commitsThisWeek,
      focusHoursThisWeek: Math.round(((focusMinutes._sum.minutes ?? 0) / 60) * 10) / 10,
    };
  }

  /** Feeds CodingStatsProvider — the compact shape used by /dashboard/home. */
  async getStats(userId: string): Promise<CodingStatsDto> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        longestStreakDays: true,
        streakFreezesAvailable: true,
        weeklyCommitGoal: true,
        weeklyIssueGoal: true,
      },
    });

    const [activeDays, weekly] = await Promise.all([
      this.getActiveDaySet(userId),
      this.getWeeklyCounters(userId),
    ]);
    const currentStreakDays = this.computeStreakFromDays(activeDays);

    await Promise.all([
      this.recordLongestIfNeeded(userId, currentStreakDays, user?.longestStreakDays ?? 0),
      this.awardMilestoneAchievements(userId, currentStreakDays),
    ]);

    const weeklyCommitGoal = user?.weeklyCommitGoal ?? 20;
    const weeklyIssueGoal = user?.weeklyIssueGoal ?? 5;

    return {
      currentStreakDays,
      ...weekly,
      longestStreakDays: Math.max(currentStreakDays, user?.longestStreakDays ?? 0),
      streakFreezesAvailable: user?.streakFreezesAvailable ?? 0,
      weeklyCommitGoal,
      weeklyIssueGoal,
      commitGoalProgress: Math.min(100, Math.round((weekly.commitsThisWeek / weeklyCommitGoal) * 100)),
      issueGoalProgress: Math.min(100, Math.round((weekly.issuesCompletedThisWeek / weeklyIssueGoal) * 100)),
    };
  }

  /** Full detail payload for the /dashboard/coding-streak page: heatmap,
   * achievements, webhook setup info. */
  async getDetail(userId: string, backendBaseUrl: string | undefined): Promise<CodingStreakDetailDto> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        longestStreakDays: true,
        streakFreezesAvailable: true,
        weeklyCommitGoal: true,
        weeklyIssueGoal: true,
        codingWebhookToken: true,
      },
    });
    if (!user) throw new Error("User not found");

    const [activeDays, weekly, achievementsRaw, freezeDates] = await Promise.all([
      this.getActiveDaySet(userId),
      this.getWeeklyCounters(userId),
      prisma.codingAchievement.findMany({
        where: { userId },
        orderBy: { unlockedAt: "desc" },
      }),
      prisma.streakFreezeUse.findMany({ where: { userId }, select: { coveredDate: true } }),
    ]);
    const currentStreakDays = this.computeStreakFromDays(activeDays);
    await this.recordLongestIfNeeded(userId, currentStreakDays, user.longestStreakDays);
    await this.awardMilestoneAchievements(userId, currentStreakDays);

    const frozenSet = new Set(freezeDates.map((f) => f.coveredDate));
    const heatmap: HeatmapCellDto[] = [];
    for (let i = HEATMAP_DAYS - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * DAY_MS);
      const key = toDateKey(d);
      const active = activeDays.has(key);
      heatmap.push({
        date: key,
        level: active ? (frozenSet.has(key) ? 1 : 2) : 0,
        frozen: frozenSet.has(key),
      });
    }

    const labelByType: Record<string, string> = Object.fromEntries(
      STREAK_MILESTONES.map((m) => [m.type, m.label]),
    );
    const achievements: AchievementDto[] = achievementsRaw.map((a) => ({
      type: a.type,
      label: labelByType[a.type] ?? a.type,
      description: `Reached via ${a.type.toLowerCase().replace(/_/g, " ")}`,
      unlockedAt: a.unlockedAt.toISOString(),
    }));

    const webhookUrl = backendBaseUrl
      ? `${backendBaseUrl.replace(/\/$/, "")}/api/webhooks/git/${user.codingWebhookToken}`
      : null;

    return {
      currentStreakDays,
      longestStreakDays: Math.max(currentStreakDays, user.longestStreakDays),
      streakFreezesAvailable: user.streakFreezesAvailable,
      heatmap,
      achievements,
      weeklyCommitGoal: user.weeklyCommitGoal,
      weeklyIssueGoal: user.weeklyIssueGoal,
      ...weekly,
      webhookUrl,
      githubActionsSnippet: [
        "- name: Report commits to TeamDesk",
        "  if: always()",
        `  run: |`,
        `    curl -X POST "${webhookUrl ?? "<YOUR_TEAMDESK_URL>/api/webhooks/git/<token>"}" \\`,
        `      -H "Content-Type: application/json" \\`,
        `      -d @- <<'EOF'`,
        `    {"commits": [{"sha": "\${{ github.sha }}", "message": \${{ toJSON(github.event.head_commit.message) }}, "repoName": "\${{ github.repository }}", "branch": "\${{ github.ref_name }}"}]}`,
        `    EOF`,
      ].join("\n"),
    };
  }

  async updateGoals(userId: string, weeklyCommitGoal?: number, weeklyIssueGoal?: number) {
    return prisma.user.update({
      where: { id: userId },
      data: {
        ...(weeklyCommitGoal !== undefined ? { weeklyCommitGoal } : {}),
        ...(weeklyIssueGoal !== undefined ? { weeklyIssueGoal } : {}),
      },
      select: { weeklyCommitGoal: true, weeklyIssueGoal: true },
    });
  }

  async logFocusSession(userId: string, minutes: number, note?: string) {
    return prisma.focusSession.create({ data: { userId, minutes, note } });
  }

  async rotateWebhookToken(userId: string): Promise<string> {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { codingWebhookToken: crypto.randomUUID() },
      select: { codingWebhookToken: true },
    });
    return updated.codingWebhookToken;
  }

  /** Ingests a GitHub (or GitHub-Actions-relayed) push payload. Looked up
   * by the per-user webhookToken embedded in the URL — same "the token
   * IS the auth" pattern as routes/ciWebhooks.ts. */
  async ingestCommits(
    webhookToken: string,
    commits: { sha: string; message: string; repoName: string; branch?: string; additions?: number; deletions?: number; committedAt?: string }[],
  ): Promise<{ userId: string; inserted: number } | null> {
    const user = await prisma.user.findUnique({
      where: { codingWebhookToken: webhookToken },
      select: { id: true },
    });
    if (!user) return null;

    // A single org isn't inferable from a bare git push, so organizationId
    // is left null here — this is a personal, cross-org commit ledger by
    // design, same "spans every org" reasoning as the /home endpoint.
    let inserted = 0;
    for (const c of commits) {
      try {
        await prisma.gitCommit.create({
          data: {
            userId: user.id,
            sha: c.sha,
            message: c.message.slice(0, 500),
            repoName: c.repoName,
            branch: c.branch,
            additions: c.additions ?? 0,
            deletions: c.deletions ?? 0,
            committedAt: c.committedAt ? new Date(c.committedAt) : new Date(),
          },
        });
        inserted++;
      } catch (err: unknown) {
        // P2002 unique violation = already ingested this sha for this
        // user (webhook retry) — skip silently, that's expected, not an
        // error worth surfacing.
        const code = (err as { code?: string })?.code;
        if (code !== "P2002") throw err;
      }
    }
    return { userId: user.id, inserted };
  }

  /** Org-scoped leaderboard: current + longest streak for every member of
   * an org the requesting user actually belongs to. Ranked by current
   * streak, ties broken by longest-ever. */
  async getLeaderboard(userId: string, organizationId: string): Promise<LeaderboardEntryDto[]> {
    const membership = await prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
    });
    if (!membership) throw new Error("Not a member of this organization");

    const members = await prisma.membership.findMany({
      where: { organizationId },
      select: { user: { select: { id: true, name: true, longestStreakDays: true } } },
    });

    const entries = await Promise.all(
      members.map(async (m) => {
        const activeDays = await this.getActiveDaySet(m.user.id);
        const currentStreakDays = this.computeStreakFromDays(activeDays);
        return {
          userId: m.user.id,
          name: m.user.name,
          currentStreakDays,
          longestStreakDays: Math.max(currentStreakDays, m.user.longestStreakDays),
          isSelf: m.user.id === userId,
        };
      }),
    );

    return entries.sort(
      (a, b) => b.currentStreakDays - a.currentStreakDays || b.longestStreakDays - a.longestStreakDays,
    );
  }

  /** Meant for a daily cron (mirrors digest.routes.ts's pattern exactly).
   * For every user whose most recent activity was exactly 2 days ago
   * (i.e. their streak is about to silently break) and who has an unused
   * freeze available, spends one freeze covering yesterday and
   * decrements their balance. Read-only for everyone else. */
  async runFreezeMaintenance(): Promise<{ usersChecked: number; freezesSpent: number }> {
    const users = await prisma.user.findMany({
      where: { streakFreezesAvailable: { gt: 0 } },
      select: { id: true, streakFreezesAvailable: true },
    });

    let freezesSpent = 0;
    const yesterday = toDateKey(new Date(Date.now() - DAY_MS));

    for (const user of users) {
      const activeDays = await this.getActiveDaySet(user.id);
      if (activeDays.has(yesterday)) continue; // no gap to cover

      const today = toDateKey(new Date());
      const sorted = Array.from(activeDays).sort().reverse();
      if (sorted.length === 0) continue;
      const mostRecentGap = daysBetween(today, sorted[0]);
      // Exactly a 2-day gap (yesterday missing, day before present) is the
      // only case a freeze should auto-apply to — a longer gap means the
      // streak is already genuinely over, not worth spending a freeze on.
      if (mostRecentGap !== 2) continue;

      try {
        await prisma.$transaction([
          prisma.streakFreezeUse.create({ data: { userId: user.id, coveredDate: yesterday } }),
          prisma.user.update({
            where: { id: user.id },
            data: { streakFreezesAvailable: { decrement: 1 } },
          }),
        ]);
        freezesSpent++;
      } catch {
        // Unique violation = already covered (job ran twice) — ignore.
      }
    }

    // Slow monthly refill (max 2 banked) — same idea as Duolingo's streak
    // freezes so users can't hoard an ever-growing safety net.
    const monthAgo = new Date(Date.now() - 30 * DAY_MS);
    await prisma.user.updateMany({
      where: { lastFreezeRefillAt: { lte: monthAgo }, streakFreezesAvailable: { lt: 2 } },
      data: { streakFreezesAvailable: { increment: 1 }, lastFreezeRefillAt: new Date() },
    });

    return { usersChecked: users.length, freezesSpent };
  }
}

export const codingStreakService = new CodingStreakService();
