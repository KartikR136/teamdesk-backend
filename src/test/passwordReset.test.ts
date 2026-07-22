import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";
import { extractCookie } from "./testUtils";
import { generatePasswordResetToken, hashPasswordResetToken } from "../lib/tokens";

// Rate-limit budget tracking (see TESTING.md, and the fix applied after
// the first run of this file): passwordResetLimiter is a SEPARATE
// 10-per-hour-per-IP bucket that applies ONLY to /forgot-password (not
// /reset-password — see rateLimiters.ts for why). Only tests that
// actually exercise /forgot-password's own behavior call it over real
// HTTP; every other test creates its PasswordResetToken row directly via
// Prisma (using the same generate/hash functions the real route uses),
// since those tests are actually testing /reset-password's behavior, not
// /forgot-password's, and shouldn't spend that budget to get there.
// Real /forgot-password calls in this file: lifecycle (1) + enumeration
// (2) = 3, well under the 10/hour limit, before the dedicated rate-limit
// test intentionally exceeds it.

async function signup(email: string, password = "correctpassword") {
  const res = await request(app).post("/api/auth/signup").send({
    email,
    password,
    name: "Reset Test User",
  });
  return {
    userId: res.body.id as string,
    accessToken: extractCookie(res.headers["set-cookie"], "accessToken"),
    refreshToken: extractCookie(res.headers["set-cookie"], "refreshToken"),
  };
}

// Captures the raw reset token from the console log emitted by
// lib/email.ts's dev-mode fallback (no real email provider exists yet —
// see PASSWORD_RESET_SCHEMA.md / PRD 5). Used only by tests that actually
// exercise the real /forgot-password endpoint.
async function forgotPasswordAndCaptureToken(email: string): Promise<string> {
  const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  try {
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email });
    expect(res.status).toBe(200);

    const logged = logSpy.mock.calls.flat().join(" ");
    const match = logged.match(/token=([a-f0-9]+)/);
    if (!match) {
      throw new Error(
        "Could not find reset token in console output — check lib/email.ts's log format.",
      );
    }
    return match[1];
  } finally {
    logSpy.mockRestore();
  }
}

// Creates a real, valid PasswordResetToken row directly via Prisma, using
// the exact same generate/hash functions routes/auth.ts uses — bypasses
// /forgot-password's HTTP call (and its rate limit) for tests that are
// actually verifying /reset-password's behavior, not /forgot-password's.
async function createResetTokenForUser(
  userId: string,
  overrides: { expiresInMs?: number } = {},
): Promise<string> {
  const rawToken = generatePasswordResetToken();
  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: hashPasswordResetToken(rawToken),
      expiresAt: new Date(Date.now() + (overrides.expiresInMs ?? 45 * 60 * 1000)),
    },
  });
  return rawToken;
}

describe("password reset", () => {
  it("full lifecycle: forgot-password, reset with token, login with new password", async () => {
    const email = "reset-lifecycle@example.com";
    await signup(email, "originalpassword");

    const rawToken = await forgotPasswordAndCaptureToken(email);

    const resetRes = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: rawToken, newPassword: "brandnewpassword" });
    expect(resetRes.status).toBe(200);

    const oldLoginRes = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "originalpassword" });
    expect(oldLoginRes.status).toBe(401);

    const newLoginRes = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "brandnewpassword" });
    expect(newLoginRes.status).toBe(200);
  });

  it("returns the identical generic response for a real vs. nonexistent email (no account enumeration)", async () => {
    const realEmail = "reset-real@example.com";
    await signup(realEmail);

    const realRes = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: realEmail });
    const fakeRes = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "definitely-not-a-real-account@example.com" });

    expect(realRes.status).toBe(fakeRes.status);
    expect(realRes.body).toEqual(fakeRes.body);
  });

  it("rejects a token that has already been used (single-use enforcement)", async () => {
    const email = "reset-singleuse@example.com";
    const { userId } = await signup(email);
    const rawToken = await createResetTokenForUser(userId);

    const firstUse = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: rawToken, newPassword: "firstnewpassword" });
    expect(firstUse.status).toBe(200);

    const replay = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: rawToken, newPassword: "secondnewpassword" });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toMatch(/invalid or has expired/i);
  });

  it("rejects an expired token", async () => {
    const email = "reset-expired@example.com";
    const { userId } = await signup(email);
    // Created with a negative TTL — already expired the moment it's made,
    // no need to fast-forward real time or mutate afterward.
    const rawToken = await createResetTokenForUser(userId, { expiresInMs: -1000 });

    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: rawToken, newPassword: "wontmatter123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid or has expired/i);
  });

  it("rejects a malformed/unknown token", async () => {
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "not-a-real-token-at-all", newPassword: "wontmatter123" });
    expect(res.status).toBe(400);
  });

  it("rejects a new password shorter than 8 characters", async () => {
    const email = "reset-shortpw@example.com";
    const { userId } = await signup(email);
    const rawToken = await createResetTokenForUser(userId);

    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: rawToken, newPassword: "short" });
    expect(res.status).toBe(400);
  });

  it("invalidates all existing sessions when the password is reset", async () => {
    const email = "reset-sessions@example.com";
    const { userId, refreshToken } = await signup(email, "originalpassword");
    const rawToken = await createResetTokenForUser(userId);

    await request(app)
      .post("/api/auth/reset-password")
      .send({ token: rawToken, newPassword: "brandnewpassword" });

    const refreshAttempt = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", [`refreshToken=${refreshToken.split("=")[1]}`]);
    expect(refreshAttempt.status).toBe(401);
  });

  it("rate-limits repeated forgot-password requests", async () => {
    const email = "reset-ratelimit@example.com";
    await signup(email);

    // This file's earlier tests already made 3 real /forgot-password
    // calls (lifecycle: 1, enumeration: 2) against the shared 5/hour/IP
    // budget. Rather than hardcoding "send exactly N more," loop until a
    // 429 actually appears (or give up after a generous ceiling) — robust
    // to the exact cumulative count without re-deriving it by hand.
    let sawRateLimited = false;
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post("/api/auth/forgot-password")
        .send({ email });
      if (res.status === 429) {
        sawRateLimited = true;
        break;
      }
    }
    expect(sawRateLimited).toBe(true);
  });
});
