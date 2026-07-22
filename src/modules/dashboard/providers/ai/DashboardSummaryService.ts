import { AISummaryDto, AssignedTaskDto } from "../../dto/dashboard.dto";

export interface SummaryInput {
  assignedTasks: AssignedTaskDto[];
  unreadNotificationCount: number;
  recentDeploymentCount: number;
  pendingReviewCount: number;
}

// Deliberately not an AI call. Generates a templated summary from data the
// dashboard already computed, matching the frontend's
// { headline, bullets: string[], generatedAt } shape exactly (see
// frontend repo's mock/dashboard.ts) — a real LLM call later is a drop-in
// replacement for this one class; nothing else in the dashboard module
// needs to change.
export class DashboardSummaryService {
  generateSummary(input: SummaryInput): AISummaryDto {
    const now = new Date();
    const bullets: string[] = [];

    const overdueTasks = input.assignedTasks.filter(
      (t) =>
        t.dueDate !== null &&
        new Date(t.dueDate) < now &&
        t.status !== "DONE",
    );
    if (input.assignedTasks.length > 0) {
      bullets.push(
        `${input.assignedTasks.length} issue${input.assignedTasks.length === 1 ? "" : "s"} assigned to you` +
          (overdueTasks.length > 0
            ? `, ${overdueTasks.length} overdue`
            : ""),
      );
    }

    if (input.pendingReviewCount > 0) {
      bullets.push(
        `${input.pendingReviewCount} pull request${input.pendingReviewCount === 1 ? "" : "s"} waiting for your review`,
      );
    }

    if (input.recentDeploymentCount > 0) {
      bullets.push(
        `${input.recentDeploymentCount} deployment${input.recentDeploymentCount === 1 ? "" : "s"} went out recently`,
      );
    }

    if (input.unreadNotificationCount > 0) {
      bullets.push(
        `${input.unreadNotificationCount} unread notification${input.unreadNotificationCount === 1 ? "" : "s"}`,
      );
    }

    if (bullets.length === 0) {
      bullets.push(
        "Nothing urgent today — no overdue tasks, pending reviews, or unread notifications",
      );
    }

    return {
      headline: "Today's Focus",
      bullets,
      generatedAt: now.toISOString(),
    };
  }
}
