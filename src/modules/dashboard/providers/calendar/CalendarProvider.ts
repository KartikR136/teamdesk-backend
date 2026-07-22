import { MeetingDto } from "../../dto/dashboard.dto";
import { ProviderResult } from "../pullRequest/PullRequestProvider";

// Google Calendar / Outlook implementations plug in here later.
export interface CalendarProvider {
  readonly name: string;
  getTodaysMeetings(userId: string): Promise<ProviderResult<MeetingDto>>;
}
