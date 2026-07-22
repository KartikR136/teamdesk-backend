import { CalendarProvider } from "./CalendarProvider";
import { MeetingDto } from "../../dto/dashboard.dto";
import { ProviderResult } from "../pullRequest/PullRequestProvider";

export class MockCalendarProvider implements CalendarProvider {
  constructor(readonly name: string) {}

  async getTodaysMeetings(
    _userId: string,
  ): Promise<ProviderResult<MeetingDto>> {
    return { integrationRequired: true, data: [] };
  }
}
