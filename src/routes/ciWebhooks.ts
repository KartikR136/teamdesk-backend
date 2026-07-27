import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { createRunAndNotify } from "./buildPipelines";

const router = Router();

// Deliberately public (no requireAuth) — a CI runner has no user session,
// only the pipeline's webhookToken as its credential. The token itself IS
// the auth: it's an unguessable uuid embedded in the URL, generated per
// pipeline (see BuildPipeline.webhookToken) and rotatable without
// affecting the pipeline's own id or history (routes/buildPipelines.ts's
// rotate-webhook endpoint).
//
// Normalized payload shape any CI provider's job can POST after its own
// test/build step finishes — deliberately provider-agnostic rather than
// GitHub-Actions-specific, so the same endpoint works for CircleCI,
// GitLab CI, Buildkite, Jenkins, or a plain curl call from any script.
//
// Example GitHub Actions step:
//   - name: Report build health
//     if: always()
//     run: |
//       curl -X POST "$BUILD_HEALTH_WEBHOOK_URL" \
//         -H "Content-Type: application/json" \
//         -d '{
//           "status": "${{ job.status == '"'"'success'"'"' && '"'"'passing'"'"' || '"'"'failing'"'"' }}",
//           "branch": "${{ github.ref_name }}",
//           "commitHash": "${{ github.sha }}",
//           "commitMessage": ${{ toJSON(github.event.head_commit.message) }},
//           "durationSeconds": 0,
//           "logsUrl": "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
//         }'
const webhookPayloadSchema = z.object({
  status: z
    .string()
    .transform((s) => s.toLowerCase())
    .pipe(
      z.enum(["passing", "failing", "success", "failure", "failed", "pass"]),
    ),
  branch: z.string().min(1).max(200).optional(),
  commitHash: z
    .string()
    .min(4)
    .max(40)
    .regex(/^[0-9a-fA-F]+$/, "commitHash must be a hex SHA"),
  commitMessage: z.string().min(1).max(500).default("(no commit message provided)"),
  testsPassing: z.coerce.number().int().nonnegative().default(0),
  testsFailing: z.coerce.number().int().nonnegative().default(0),
  testsSkipped: z.coerce.number().int().nonnegative().default(0),
  coveragePercent: z.coerce.number().min(0).max(100).optional(),
  durationSeconds: z.coerce.number().int().nonnegative().default(0),
  logsUrl: z.string().url().optional(),
  failureSummary: z.string().max(2000).optional(),
  pullRequestId: z.string().uuid().optional(),
});

function normalizeStatus(raw: string): "PASSING" | "FAILING" {
  return raw === "failing" || raw === "failure" || raw === "failed"
    ? "FAILING"
    : "PASSING";
}

router.post("/:webhookToken", async (req, res) => {
  const { webhookToken } = req.params;

  const pipeline = await prisma.buildPipeline.findUnique({
    where: { webhookToken },
  });
  // Deliberately identical 404 whether the token is malformed, unknown,
  // or belongs to a deactivated pipeline — never confirm to an
  // unauthenticated caller which of those is true.
  if (!pipeline || !pipeline.isActive) {
    return res.status(404).json({ error: "Unknown or inactive webhook" });
  }

  const parsed = webhookPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const data = parsed.data;

  if (data.pullRequestId) {
    const pr = await prisma.pullRequest.findUnique({
      where: { id: data.pullRequestId },
    });
    if (!pr || pr.organizationId !== pipeline.organizationId) {
      return res.status(400).json({ error: "pullRequestId not in this organization" });
    }
  }

  const status = normalizeStatus(data.status);
  const completedAt = new Date();
  const startedAt = new Date(completedAt.getTime() - data.durationSeconds * 1000);

  const run = await createRunAndNotify({
    pipeline,
    branch: data.branch ?? pipeline.defaultBranch,
    commitHash: data.commitHash,
    commitMessage: data.commitMessage,
    status,
    testsPassing: data.testsPassing,
    testsFailing: data.testsFailing,
    testsSkipped: data.testsSkipped,
    coveragePercent: data.coveragePercent ?? 0,
    durationSeconds: data.durationSeconds,
    startedAt,
    completedAt,
    pullRequestId: data.pullRequestId ?? null,
    triggeredById: null,
    source: pipeline.provider.toLowerCase(),
    failureSummary: data.failureSummary,
    logsUrl: data.logsUrl,
    actorUserId: null,
  });

  res.status(201).json({ received: true, buildRunId: run.id, buildNumber: run.buildNumber });
});

export default router;
