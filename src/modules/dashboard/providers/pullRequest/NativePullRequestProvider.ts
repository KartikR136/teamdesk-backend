import { prisma } from "../../../../lib/prisma";
import { PullRequestProvider, ProviderResult } from "./PullRequestProvider";
import { PullRequestDto, PRReviewUrgency } from "../../dto/dashboard.dto";

const MERGE_STATUS_MAP: Record<string, PullRequestDto["mergeStatus"]> = {
  CLEAN: "clean",
  CONFLICTS: "conflicts",
  CHECKS_FAILING: "checks_failing",
};

// Urgency is deliberately computed, not stored — same reasoning as
// MeetingsCard's `isSoon()`/`isPast()` helpers being derived from
// `startsAt` on the frontend rather than persisted. It's a function of
// "how long has this been waiting on me" plus "is something already
// broken" (conflicts/failing checks escalate a PR a reviewer might
// otherwise deprioritize), so it's always current and never drifts out
// of sync with the clock.
function computeUrgency(
  openedAt: Date,
  mergeStatus: string,
  hasApproval: boolean,
): PRReviewUrgency {
  const hoursOpen = (Date.now() - openedAt.getTime()) / 3600000;

  let base: PRReviewUrgency;
  if (hasApproval) base = "low";
  else if (hoursOpen >= 48) base = "high";
  else if (hoursOpen >= 12) base = "medium";
  else base = "low";

  // A broken build/merge conflict bumps urgency up one level regardless
  // of how long it's been open — a fresh PR with failing checks still
  // deserves more attention than a stale-but-clean one.
  if (mergeStatus !== "CLEAN" && base === "low") return "medium";
  if (mergeStatus !== "CLEAN" && base === "medium") return "high";
  return base;
}

// Replaces GitHubPullRequestProvider now that pull-request review
// tracking is a first-class, native feature (see prisma schema's
// PullRequest model and routes/pullRequests.ts) rather than a
// placeholder for a future GitHub OAuth/App integration.
// `integrationRequired` is always false here — same reasoning as
// NativeMeetingCalendarProvider. A real GitHub provider could still be
// added later as an additional source merged alongside this one.
export class NativePullRequestProvider implements PullRequestProvider {
  readonly name = "native";

  async getPendingReviews(
    userId: string,
  ): Promise<ProviderResult<PullRequestDto>> {
    const memberships = await prisma.membership.findMany({
      where: { userId },
      select: { organizationId: true },
    });
    const orgIds = memberships.map((m) => m.organizationId);
    if (orgIds.length === 0) {
      return { integrationRequired: false, data: [] };
    }

    // "Awaiting review" = OPEN pull requests in one of my orgs where I'm
    // a requested reviewer and haven't already approved. PRs I've
    // requested changes on or merely commented on still show up here —
    // they're still awaiting a final decision from me — only an
    // APPROVED review clears a PR off this list.
    const prs = await prisma.pullRequest.findMany({
      where: {
        organizationId: { in: orgIds },
        status: "OPEN",
        reviewers: { some: { userId, status: { not: "APPROVED" } } },
      },
      orderBy: { createdAt: "asc" },
      include: {
        organization: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
        author: { select: { name: true } },
        reviewers: { select: { userId: true, status: true } },
        _count: { select: { linkedIssues: true, comments: true } },
      },
    });

    const data: PullRequestDto[] = prs.map((pr) => {
      const mergeStatus = MERGE_STATUS_MAP[pr.mergeStatus] ?? "clean";
      const hasApproval = pr.reviewers.some((r) => r.status === "APPROVED");
      const myReview = pr.reviewers.find((r) => r.userId === userId);

      return {
        id: pr.id,
        repo: pr.repoName,
        branch: pr.sourceBranch,
        title: pr.title,
        author: pr.author.name,
        openedAt: pr.createdAt.toISOString(),
        filesChanged: pr.filesChanged,
        mergeStatus,
        urgency: computeUrgency(pr.createdAt, pr.mergeStatus, hasApproval),
        url: pr.externalUrl ?? `/dashboard/pull-requests/${pr.id}`,
        organizationId: pr.organizationId,
        organizationName: pr.organization.name,
        projectId: pr.projectId,
        projectName: pr.project?.name ?? null,
        targetBranch: pr.targetBranch,
        status: pr.status,
        linesAdded: pr.linesAdded,
        linesRemoved: pr.linesRemoved,
        myReviewStatus: myReview?.status,
        isAuthor: pr.authorId === userId,
        linkedIssueCount: pr._count.linkedIssues,
        commentCount: pr._count.comments,
      };
    });

    return { integrationRequired: false, data };
  }
}
