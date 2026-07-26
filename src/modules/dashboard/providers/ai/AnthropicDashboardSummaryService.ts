import { AISummaryDto, AssignedTaskDto } from "../../dto/dashboard.dto";
import { DashboardSummaryService, SummaryInput } from "./DashboardSummaryService";
import { AISummaryCacheStore } from "./AISummaryCacheStore";
import { env } from "../../../../config/env";

/** Extra grounding context beyond the four counters the template uses —
 * this is the "RAG-lite" part: real titles/messages from the user's own
 * data, not just numbers, so the model can write something a teammate
 * would actually say instead of a generic recap. */
export interface RichSummaryInput extends SummaryInput {
  overdueTaskTitles: string[];
  topPriorityTaskTitles: string[];
  recentNotificationMessages: string[];
  upcomingMeetingTitles: string[];
}

const SYSTEM_PROMPT = `You write a single short "Today's Focus" briefing for a developer dashboard.
Rules:
- Return ONLY valid JSON, no markdown fences, no commentary.
- Shape: {"headline": string, "bullets": string[]}
- headline: 2-5 words, e.g. "Today's Focus", "Steady Day Ahead", "Review Queue Building Up".
- bullets: 2-4 short items (max ~14 words each), concrete and specific — reference actual task titles or numbers given, don't invent facts not present in the input.
- Tone: calm, direct, encouraging but not saccharine. No emoji.
- If nothing is urgent, say so plainly instead of padding with filler.`;

export class AnthropicDashboardSummaryService {
  private readonly fallback = new DashboardSummaryService();
  private readonly cache = new AISummaryCacheStore();

  constructor(private readonly apiKey: string = env.anthropicApiKey || "") {}

  async generateSummary(userId: string, input: RichSummaryInput): Promise<AISummaryDto> {
    const contextHash = AISummaryCacheStore.hashContext(input as unknown as Record<string, unknown>);

    const cached = await this.cache.get(userId, contextHash);
    if (cached) return cached;

    const summary = await this.generateFresh(input);
    const model = this.apiKey ? env.aiSummaryModel : "template-fallback";
    await this.cache.set(userId, contextHash, summary, model);
    return summary;
  }

  private async generateFresh(input: RichSummaryInput): Promise<AISummaryDto> {
    if (!this.apiKey) {
      // No key configured — degrade to the deterministic template rather
      // than failing the whole dashboard request.
      return this.fallback.generateSummary(input);
    }

    try {
      const userPrompt = JSON.stringify({
        assignedTaskCount: input.assignedTasks.length,
        overdueTaskTitles: input.overdueTaskTitles.slice(0, 5),
        topPriorityTaskTitles: input.topPriorityTaskTitles.slice(0, 5),
        pendingReviewCount: input.pendingReviewCount,
        recentDeploymentCount: input.recentDeploymentCount,
        unreadNotificationCount: input.unreadNotificationCount,
        recentNotificationMessages: input.recentNotificationMessages.slice(0, 5),
        upcomingMeetingTitles: input.upcomingMeetingTitles.slice(0, 3),
      });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      let res: Response;
      try {
        res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: env.aiSummaryModel,
            max_tokens: 300,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userPrompt }],
          }),
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) throw new Error(`Anthropic API returned ${res.status}`);

      const data = (await res.json()) as {
        content: { type: string; text?: string }[];
      };
      const text = data.content.find((b) => b.type === "text")?.text ?? "";
      const cleaned = text.replace(/^```json|```$/g, "").trim();
      const parsed = JSON.parse(cleaned) as { headline: string; bullets: string[] };

      if (!parsed.headline || !Array.isArray(parsed.bullets) || parsed.bullets.length === 0) {
        throw new Error("Malformed AI summary response");
      }

      return {
        headline: parsed.headline,
        bullets: parsed.bullets,
        generatedAt: new Date().toISOString(),
      };
    } catch (err) {
      // Any failure (timeout, bad JSON, API error) falls back to the
      // template generator — the dashboard should never break because
      // the LLM had a bad moment.
      console.error("[AnthropicDashboardSummaryService] falling back to template:", err);
      return this.fallback.generateSummary(input);
    }
  }
}

/** Helper for building RichSummaryInput's grounding fields from data the
 * dashboard service already fetched in its Promise.all — no extra queries. */
export function buildRichContext(
  base: SummaryInput,
  extras: {
    overdueTasks: AssignedTaskDto[];
    topPriorityTasks: AssignedTaskDto[];
    recentNotificationMessages: string[];
    upcomingMeetingTitles: string[];
  },
): RichSummaryInput {
  return {
    ...base,
    overdueTaskTitles: extras.overdueTasks.map((t) => t.title),
    topPriorityTaskTitles: extras.topPriorityTasks.map((t) => t.title),
    recentNotificationMessages: extras.recentNotificationMessages,
    upcomingMeetingTitles: extras.upcomingMeetingTitles,
  };
}
