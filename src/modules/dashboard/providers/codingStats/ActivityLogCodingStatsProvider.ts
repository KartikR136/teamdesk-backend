import { CodingStatsProvider } from "./CodingStatsProvider";
import { CodingStatsDto } from "../../dto/dashboard.dto";
import { codingStreakService } from "../../service/codingStreak.service";

// All five fields are now real:
//
//   currentStreakDays        REAL — ActivityLog + GitCommit + freeze-covered days
//   issuesCompletedThisWeek  REAL — Issues this user completed in the last 7 days
//   reviewsCompletedThisWeek REAL — PullRequestReviewer responses in the last 7 days
//   commitsThisWeek          REAL once the user wires up the git-push webhook,
//                            honest 0 until then (see GitCommit / codingStreak.service.ts)
//   focusHoursThisWeek       REAL, self-reported via FocusSession — honest 0 until
//                            the user logs their first session
//
// The heavy lifting (streak math, weekly counters, achievements, goals)
// all lives in CodingStreakService now — this class is just the thin
// adapter that satisfies the CodingStatsProvider interface for
// DashboardService's Promise.all fan-out.
export class ActivityLogCodingStatsProvider implements CodingStatsProvider {
  readonly name = "activity-log";

  async getStats(userId: string): Promise<CodingStatsDto> {
    return codingStreakService.getStats(userId);
  }
}
