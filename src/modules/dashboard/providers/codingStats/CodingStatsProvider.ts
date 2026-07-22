import { CodingStatsDto } from "../../dto/dashboard.dto";

// Unlike the other provider interfaces, there's a real, non-mock
// implementation of this one today (ActivityLogCodingStatsProvider) for
// two of its five fields — TeamDesk already has activity data to derive a
// streak and a weekly issues-completed count from. `commitsThisWeek` and
// `focusHoursThisWeek` need a real GitHub/time-tracking integration that
// doesn't exist yet, so they're honestly 0, not fabricated — see that
// class's comments for exactly which fields are real vs. placeholder today.
export interface CodingStatsProvider {
  readonly name: string;
  getStats(userId: string): Promise<CodingStatsDto>;
}
