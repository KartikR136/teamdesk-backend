import { Router } from "express";
import { z } from "zod";
import { codingStreakService } from "../modules/dashboard/service/codingStreak.service";

const router = Router();

// Deliberately public (no requireAuth) — same reasoning as ciWebhooks.ts:
// there's no user session on the other end, just the per-user
// codingWebhookToken embedded in the URL, which is itself the credential
// (an unguessable uuid, generated per user, rotatable via
// POST /api/dashboard/coding-streak/webhook/rotate without losing GitCommit
// history since old commits keep their userId regardless of token changes).
//
// Accepts either:
//   - a raw GitHub push event (has req.body.commits[] with GitHub's own
//     shape: id, message, added/removed/modified, timestamp), or
//   - our own normalized shape (see CodingStreakService.getDetail's
//     githubActionsSnippet), whichever is easier for the caller to send.
//
// Example GitHub Actions step (also returned per-user by the API):
//   - name: Report commits to TeamDesk
//     if: always()
//     run: |
//       curl -X POST "$TEAMDESK_GIT_WEBHOOK_URL" \
//         -H "Content-Type: application/json" \
//         -d "{\"commits\":[{\"sha\":\"${{ github.sha }}\",\"message\":${{ toJSON(github.event.head_commit.message) }},\"repoName\":\"${{ github.repository }}\",\"branch\":\"${{ github.ref_name }}\"}]}"
//
// A real GitHub repo webhook (Settings > Webhooks, content type
// application/json, event: "push") also works directly against this URL —
// GitHub's own push payload commit shape (id/message/timestamp) is
// accepted below alongside the normalized shape.
const githubCommitSchema = z.object({
  sha: z.string().optional(),
  id: z.string().optional(),
  message: z.string().min(1).max(2000),
  repoName: z.string().optional(),
  branch: z.string().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  committedAt: z.string().optional(),
  timestamp: z.string().optional(),
});

const payloadSchema = z.object({
  commits: z.array(githubCommitSchema).max(200),
  repository: z.object({ full_name: z.string().optional() }).optional(),
  ref: z.string().optional(),
});

router.post("/:webhookToken", async (req, res) => {
  const { webhookToken } = req.params;

  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { commits, repository, ref } = parsed.data;

  const normalized = commits
    .map((c) => ({
      sha: c.sha ?? c.id,
      message: c.message,
      repoName: c.repoName ?? repository?.full_name ?? "unknown",
      branch: c.branch ?? ref?.replace("refs/heads/", ""),
      additions: c.additions,
      deletions: c.deletions,
      committedAt: c.committedAt ?? c.timestamp,
    }))
    .filter((c): c is typeof c & { sha: string } => Boolean(c.sha));

  if (normalized.length === 0) {
    return res.status(400).json({ error: "No commits with a sha/id were provided" });
  }

  const result = await codingStreakService.ingestCommits(webhookToken, normalized);

  // Same identical-404 convention as ciWebhooks.ts — don't confirm to an
  // unauthenticated caller whether the token is malformed or just unknown.
  if (!result) {
    return res.status(404).json({ error: "Unknown webhook token" });
  }

  res.status(201).json({ received: true, inserted: result.inserted });
});

export default router;
