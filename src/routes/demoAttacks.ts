import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { signAccessToken } from "../lib/tokens";
import { env } from "../config/env";

const router = Router();

// Any authenticated user can view/run these — DEMO_MODE gating at mount
// time (see app.ts) is what keeps this route from existing at all outside
// a demo deployment. requireAuth here is defense in depth, not the primary
// control.
router.use(requireAuth);

// These scenarios exercise the REAL HTTP layer — real middleware, real route
// handlers — via self-referential fetch calls, rather than calling internal
// functions directly. A scenario passing proves the deployed route is safe,
// not just that some helper function is.
const BASE_URL =
  process.env.DEMO_INTERNAL_BASE_URL ??
  `http://localhost:${process.env.PORT ?? 4000}`;

interface ScenarioResult {
  id: string;
  title: string;
  expectedOutcome: string;
  actualOutcome: string;
  passed: boolean;
  mechanism: string;
}

interface Scenario {
  id: string;
  title: string;
  description: string;
  run: () => Promise<ScenarioResult>;
}

// Mints a real, validly-signed access token for a seeded demo user — the
// same signAccessToken() the login route calls — then wraps it as a cookie
// header. This is not bypassing auth: it represents "this user is logged
// in," a precondition every scenario needs, not the thing being tested.
async function cookieHeaderFor(
  email: string,
): Promise<{ cookie: string; userId: string }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const token = signAccessToken({ userId: user.id });
  return { cookie: `accessToken=${token}`, userId: user.id };
}

function describeError(body: any): string {
  if (!body?.error) return "";
  const err = body.error;
  const text = typeof err === "string" ? err : JSON.stringify(err);
  return ` ("${text}")`;
}

async function callApi(
  path: string,
  cookie: string,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      ...(init.headers ?? {}),
    },
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const scenarios: Scenario[] = [
  {
    id: "idor-cross-org-issue",
    title: "Cross-org issue access (IDOR)",
    description:
      "An Org A admin attempts to fetch a specific issue that belongs to Org B, by ID, without ever being a member of Org B.",
    run: async () => {
      const orgBIssue = await prisma.issue.findFirstOrThrow({
        where: { organization: { slug: "demo-org-b" } },
      });
      const { cookie } = await cookieHeaderFor("admin-a@demo.teamdesk.dev");

      const { status } = await callApi(`/api/issues/${orgBIssue.id}`, cookie);

      // Previously this scenario accepted 403 OR 404, and THREAT_MODEL.md
      // named the inconsistency as a residual risk: requireRole returned
      // a uniform 403 for missing membership regardless of whether org
      // context came from a URL param or a resource lookup, even though
      // API.md always documented 404 for the resource-derived case. That
      // gap is now closed — requireRole's notFoundIfNoMembership option is
      // set on every resource-derived route, so this scenario now asserts
      // the single correct outcome, not an either/or.
      const passed = status === 404;
      return {
        id: "idor-cross-org-issue",
        title: "Cross-org issue access (IDOR)",
        expectedOutcome:
          "404 Not Found — indistinguishable from the issue not existing at all",
        actualOutcome: `Received ${status}`,
        passed,
        mechanism:
          "resolveOrgFromIssue derived organizationId from the issue's own DB row, never the client. requireRole then found no Membership for the requesting user in that org and, because this route is resource-derived, returned a generic 404 rather than a 403 that would confirm the issue exists in some other org.",
      };
    },
  },
  {
    id: "idor-cross-org-decision",
    title: "Cross-org Decision Log access (IDOR)",
    description:
      "An Org A admin attempts to fetch a specific Decision Log entry that belongs to Org B, by ID, without ever being a member of Org B.",
    run: async () => {
      const orgBDecision = await prisma.decisionLog.findFirstOrThrow({
        where: { organization: { slug: "demo-org-b" } },
      });
      const { cookie } = await cookieHeaderFor("admin-a@demo.teamdesk.dev");

      const { status } = await callApi(
        `/api/decisions/${orgBDecision.id}`,
        cookie,
      );

      const passed = status === 404;
      return {
        id: "idor-cross-org-decision",
        title: "Cross-org Decision Log access (IDOR)",
        expectedOutcome:
          "404 Not Found — same guarantee already proven for issues, applied to Decision Log",
        actualOutcome: `Received ${status}`,
        passed,
        mechanism:
          "resolveOrgFromDecision derived organizationId from the DecisionLog row itself, never the client — identical pattern to resolveOrgFromIssue. requireRole then found no Membership for the requesting user and returned 404, since this route is resource-derived.",
      };
    },
  },
  {
    id: "cursor-replay-cross-org",
    title: "Pagination cursor replay across organizations",
    description:
      "A valid pagination cursor minted while listing Org A's issues is replayed against Org B's issue-list endpoint by a user who only belongs to Org A.",
    run: async () => {
      const orgA = await prisma.organization.findUniqueOrThrow({
        where: { slug: "demo-org-a" },
      });
      const orgB = await prisma.organization.findUniqueOrThrow({
        where: { slug: "demo-org-b" },
      });
      const { cookie } = await cookieHeaderFor("admin-a@demo.teamdesk.dev");

      const firstPage = await callApi(
        `/api/organizations/${orgA.id}/issues?limit=1`,
        cookie,
      );
      const cursor = firstPage.body?.nextCursor;

      if (!cursor) {
        return {
          id: "cursor-replay-cross-org",
          title: "Pagination cursor replay across organizations",
          expectedOutcome:
            "A real Org A cursor exists and is rejected when replayed against Org B",
          actualOutcome:
            "Could not obtain a nextCursor from Org A's list — re-run `npx prisma db seed`.",
          passed: false,
          mechanism: "n/a — scenario precondition not met",
        };
      }

      const replay = await callApi(
        `/api/organizations/${orgB.id}/issues?limit=1&cursor=${encodeURIComponent(cursor)}`,
        cookie,
      );

      const passed = replay.status === 403;
      return {
        id: "cursor-replay-cross-org",
        title: "Pagination cursor replay across organizations",
        expectedOutcome:
          "403 Forbidden — a cross-org cursor never reaches pagination logic",
        actualOutcome: `Received ${replay.status}`,
        passed,
        mechanism:
          "requireRole re-checked Membership for the authenticated user against Org B's ID (resolved server-side from the URL) before the request ever reached buildPaginationArgs — a valid cursor from a different org is never sufficient on its own.",
      };
    },
  },
  {
    id: "client-supplied-org-escalation",
    title: "Client-supplied cross-org project reference",
    description:
      "An Org A member creates an issue in Org A but supplies a projectId that actually belongs to Org B.",
    run: async () => {
      const orgA = await prisma.organization.findUniqueOrThrow({
        where: { slug: "demo-org-a" },
      });
      const orgBProject = await prisma.project.findFirstOrThrow({
        where: { organization: { slug: "demo-org-b" } },
      });
      const { cookie } = await cookieHeaderFor("admin-a@demo.teamdesk.dev");

      const { status, body } = await callApi(
        `/api/organizations/${orgA.id}/issues`,
        cookie,
        {
          method: "POST",
          body: JSON.stringify({
            title: "Attempted cross-org issue",
            projectId: orgBProject.id,
          }),
        },
      );

      const passed = status === 404;
      return {
        id: "client-supplied-org-escalation",
        title: "Client-supplied cross-org project reference",
        expectedOutcome:
          "404 Not Found — the projectId is rejected as not belonging to the caller's org",
        actualOutcome: `Received ${status}${describeError(body)}`,
        passed,
        mechanism:
          "The route independently re-verified project.organizationId === req.organizationId (both server-derived) before creating the issue, rather than trusting that passing requireRole for Org A implies the projectId is safe.",
      };
    },
  },
  {
    id: "forged-role-in-jwt",
    title: "Forged role claim in a validly-signed token",
    description:
      "A VIEWER-role user's access token is re-minted with a genuine signature but an extra, unsolicited 'role: ADMIN' claim injected into the payload.",
    run: async () => {
      const viewer = await prisma.user.findUniqueOrThrow({
        where: { email: "member-a@demo.teamdesk.dev" },
      });
      const orgAIssue = await prisma.issue.findFirstOrThrow({
        where: { organization: { slug: "demo-org-a" } },
      });

      // Validly signed with the REAL secret — this isn't a signature-forgery
      // test. It tests whether the server ever reads a role claim off the
      // token at all, even a genuinely, correctly signed one.
      const forgedToken = jwt.sign(
        { userId: viewer.id, role: "ADMIN" },
        env.jwtAccessSecret!,
        { expiresIn: "15m" },
      );

      const { status, body } = await callApi(
        `/api/issues/${orgAIssue.id}`,
        `accessToken=${forgedToken}`,
        {
          method: "PATCH",
          body: JSON.stringify({ title: "Escalation attempt" }),
        },
      );

      const passed = status === 403;
      return {
        id: "forged-role-in-jwt",
        title: "Forged role claim in a validly-signed token",
        expectedOutcome:
          "403 Forbidden — the injected role claim is never consulted",
        actualOutcome: `Received ${status}${describeError(body)}`,
        passed,
        mechanism:
          "requireAuth only ever reads payload.userId off the token; requireRole always re-queries Membership.role from the database (or its 60s Redis cache) fresh, so a role claim embedded in the JWT — even one with a valid signature — has no code path that reads it.",
      };
    },
  },
  {
    id: "last-admin-lockout",
    title: "Sole-admin self-removal lockout",
    description:
      "The only ADMIN of an organization attempts to remove their own membership from that organization.",
    run: async () => {
      const orgA = await prisma.organization.findUniqueOrThrow({
        where: { slug: "demo-org-a" },
      });
      const { cookie, userId } = await cookieHeaderFor(
        "admin-a@demo.teamdesk.dev",
      );

      const { status, body } = await callApi(
        `/api/organizations/${orgA.id}/members/${userId}`,
        cookie,
        { method: "DELETE" },
      );

      const passed = status === 400 || status === 403;
      return {
        id: "last-admin-lockout",
        title: "Sole-admin self-removal lockout",
        expectedOutcome:
          "400 or 403 — removal blocked because this is the org's sole remaining admin",
        actualOutcome: `Received ${status}${describeError(body)}`,
        passed,
        mechanism:
          "The members route counts remaining ADMIN memberships for the org before allowing a removal and blocks it when the target is the last one, regardless of who is requesting it.",
      };
    },
  },
];

router.get("/attack-scenarios", (_req: Request, res: Response) => {
  res.json(
    scenarios.map(({ id, title, description }) => ({ id, title, description })),
  );
});

router.post(
  "/attack-scenarios/:id/run",
  async (req: Request, res: Response) => {
    const scenario = scenarios.find((s) => s.id === req.params.id);
    if (!scenario) {
      return res.status(404).json({ error: "Unknown scenario" });
    }

    try {
      const result = await scenario.run();
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error:
          "Scenario failed to execute — likely missing seed data. Run `npx prisma db seed`.",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

export default router;
