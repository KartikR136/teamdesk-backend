import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";
import { extractCookie } from "./testUtils";
import {
  generateEmailVerificationToken,
  hashEmailVerificationToken,
} from "../lib/tokens";

// Same rate-limit budget bookkeeping as passwordReset.test.ts:
// resendVerificationLimiter is a SEPARATE 5-per-hour-per-IP bucket that
// applies ONLY to /resend-verification (not /verify-email — see
// rateLimiters.ts). Only tests that actually exercise /resend-verification
// over real HTTP spend that budget; every other test creates its
// EmailVerificationToken row directly via Prisma (using the same
// generate/hash functions the real route uses), since those tests are
// actually testing /verify-email's behavior, not /resend-verification's.

async function signup(email: string, password = "correctpassword") {
  const res = await request(app).post("/api/auth/signup").send({
    email,
    password,
    name: "Verification Test User",
  });
  return {
    userId: res.body.id as string,
    accessToken: extractCookie(res.headers["set-cookie"], "accessToken"),
    refreshToken: extractCookie(res.headers["set-cookie"], "refreshToken"),
  };
}

// Captures the raw verification token from the console log emitted by
// lib/email.ts's dev-mode fallback (no real email provider exists yet).
// Signup itself triggers the send, so this wraps signup and returns both.
async function signupAndCaptureToken(
  email: string,
  password = "correctpassword",
): Promise<{ userId: string; token: string }> {
  const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  try {
    const { userId } = await signup(email, password);

    const logged = logSpy.mock.calls.flat().join(" ");
    const match = logged.match(/token=([a-f0-9]+)/);
    if (!match) {
      throw new Error(
        "Could not find verification token in console output — check lib/email.ts's log format.",
      );
    }
    return { userId, token: match[1] };
  } finally {
    logSpy.mockRestore();
  }
}

// Creates a real, valid EmailVerificationToken row directly via Prisma,
// using the exact same generate/hash functions routes/auth.ts uses —
// bypasses signup's own send for tests that are actually verifying
// /verify-email's behavior in isolation (e.g. expiry).
async function createVerificationTokenForUser(
  userId: string,
  overrides: { expiresInMs?: number } = {},
): Promise<string> {
  const rawToken = generateEmailVerificationToken();
  await prisma.emailVerificationToken.create({
    data: {
      userId,
      tokenHash: hashEmailVerificationToken(rawToken),
      expiresAt: new Date(
        Date.now() + (overrides.expiresInMs ?? 24 * 60 * 60 * 1000),
      ),
    },
  });
  return rawToken;
}

describe("email verification", () => {
  it("sends a verification email on signup, and the new account starts unverified", async () => {
    const email = "verify-signup@example.com";

    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const signupRes = await request(app).post("/api/auth/signup").send({
      email,
      password: "correctpassword",
      name: "Verification Test User",
    });
    const logged = logSpy.mock.calls.flat().join(" ");
    logSpy.mockRestore();

    expect(signupRes.status).toBe(201);
    expect(signupRes.body.emailVerified).toBe(false);
    expect(logged).toMatch(
      /\[email verification\] Would email verify-signup@example\.com/,
    );
    expect(logged).toMatch(/token=[a-f0-9]+/);
  });

  it("full lifecycle: signup, verify with token, account is marked verified", async () => {
    const email = "verify-lifecycle@example.com";
    const { token } = await signupAndCaptureToken(email);

    const verifyRes = await request(app)
      .post("/api/auth/verify-email")
      .send({ token });
    expect(verifyRes.status).toBe(200);

    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "correctpassword" });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.emailVerified).toBe(true);
  });

  it("rejects a token that has already been used (single-use enforcement)", async () => {
    const email = "verify-singleuse@example.com";
    const { userId } = await signup(email);
    const rawToken = await createVerificationTokenForUser(userId);

    const firstUse = await request(app)
      .post("/api/auth/verify-email")
      .send({ token: rawToken });
    expect(firstUse.status).toBe(200);

    const replay = await request(app)
      .post("/api/auth/verify-email")
      .send({ token: rawToken });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toMatch(/invalid or has expired/i);
  });

  it("rejects an expired token", async () => {
    const email = "verify-expired@example.com";
    const { userId } = await signup(email);
    // Created with a negative TTL — already expired the moment it's made,
    // no need to fast-forward real time or mutate afterward.
    const rawToken = await createVerificationTokenForUser(userId, {
      expiresInMs: -1000,
    });

    const res = await request(app)
      .post("/api/auth/verify-email")
      .send({ token: rawToken });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid or has expired/i);
  });

  it("rejects a malformed/unknown token", async () => {
    const res = await request(app)
      .post("/api/auth/verify-email")
      .send({ token: "not-a-real-token-at-all" });
    expect(res.status).toBe(400);
  });

  it("does not block login or /me while unverified — verification is informational, not a login gate", async () => {
    const email = "verify-unblocked@example.com";
    const { accessToken } = await signup(email);

    const meRes = await request(app)
      .get("/api/auth/me")
      .set("Cookie", [`accessToken=${accessToken.split("=")[1]}`]);
    expect(meRes.status).toBe(200);
    expect(meRes.body.emailVerified).toBe(false);
  });

  it("returns the identical generic response for a real vs. nonexistent email on resend (no account enumeration)", async () => {
    const realEmail = "verify-resend-real@example.com";
    await signup(realEmail);

    const realRes = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: realEmail });
    const fakeRes = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: "definitely-not-a-real-account@example.com" });

    expect(realRes.status).toBe(fakeRes.status);
    expect(realRes.body).toEqual(fakeRes.body);
  });

  it("resend returns the same generic response for an already-verified account too (idempotent, no enumeration of verification status)", async () => {
    const email = "verify-resend-already@example.com";
    const { token } = await signupAndCaptureToken(email);
    await request(app).post("/api/auth/verify-email").send({ token });

    const res = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if an account exists/i);
  });

  it("resend issues a new, independently valid token for an unverified account", async () => {
    const email = "verify-resend-newtoken@example.com";
    const { userId } = await signup(email);
    const oldToken = await createVerificationTokenForUser(userId);

    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const resendRes = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email });
    const logged = logSpy.mock.calls.flat().join(" ");
    logSpy.mockRestore();

    expect(resendRes.status).toBe(200);
    const match = logged.match(/token=([a-f0-9]+)/);
    expect(match).not.toBeNull();
    const newToken = match![1];
    expect(newToken).not.toEqual(oldToken);

    // Both tokens are independently valid — resend doesn't invalidate
    // earlier outstanding links, only /verify-email consuming one does.
    const verifyWithNew = await request(app)
      .post("/api/auth/verify-email")
      .send({ token: newToken });
    expect(verifyWithNew.status).toBe(200);
  });

  it("rejects disposable/throwaway email domains at signup", async () => {
    const res = await request(app).post("/api/auth/signup").send({
      email: "someone@mailinator.com",
      password: "correctpassword",
      name: "Disposable Email User",
    });
    expect(res.status).toBe(400);
  });

  it("normalizes email case at signup so login is case-insensitive", async () => {
    const email = "Verify-Case@Example.com";
    await signup(email);

    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: "verify-case@example.com", password: "correctpassword" });
    expect(loginRes.status).toBe(200);
  });

  it("rate-limits repeated resend-verification requests", async () => {
    const email = "verify-ratelimit@example.com";
    await signup(email);

    // Same robust-to-exact-count approach as passwordReset.test.ts's
    // rate-limit test: loop until a 429 actually appears rather than
    // hardcoding a count derived from this file's earlier real-HTTP
    // /resend-verification calls (currently 2: enumeration + idempotent-
    // already-verified tests), against the 5/hour/IP budget.
    let sawRateLimited = false;
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post("/api/auth/resend-verification")
        .send({ email });
      if (res.status === 429) {
        sawRateLimited = true;
        break;
      }
    }
    expect(sawRateLimited).toBe(true);
  });
});
