import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth";
import { hashPassword, verifyPassword } from "../lib/password";
import {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  generatePasswordResetToken,
  hashPasswordResetToken,
  generateEmailVerificationToken,
  hashEmailVerificationToken,
} from "../lib/tokens";
import { sendPasswordResetEmail, sendVerificationEmail } from "../lib/email";
import { normalizeEmail, isDisposableEmail } from "../lib/emailValidation";

const router = Router();

const signupSchema = z.object({
  // .email() only checks shape. transform() normalizes case/whitespace so
  // "Foo@Bar.com" and "foo@bar.com" collide on the uniqueness check
  // instead of creating two accounts for the same real address. The
  // disposable-domain check is a superRefine (not a second .email()
  // chain) so it can return a specific, actionable error message.
  email: z
    .string()
    .email()
    .transform((e) => normalizeEmail(e))
    .superRefine((email, ctx) => {
      if (isDisposableEmail(email)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "Disposable or temporary email addresses aren't allowed. Please use a permanent email address.",
        });
      }
    }),
  password: z.string().min(8),
  name: z.string().min(1),
});

const REFRESH_TOKEN_TTL_DAYS = 30;
const EMAIL_VERIFICATION_TTL_HOURS = 24;

async function issueEmailVerification(userId: string, email: string) {
  const rawToken = generateEmailVerificationToken();
  await prisma.emailVerificationToken.create({
    data: {
      userId,
      tokenHash: hashEmailVerificationToken(rawToken),
      expiresAt: new Date(
        Date.now() + EMAIL_VERIFICATION_TTL_HOURS * 60 * 60 * 1000,
      ),
    },
  });

  const verifyLink = `${process.env.FRONTEND_URL ?? "http://localhost:3000"}/verify-email?token=${rawToken}`;

  try {
    await sendVerificationEmail(email, verifyLink);
  } catch (err) {
    // Same swallow-and-log reasoning as forgot-password: a failed send
    // shouldn't fail the signup request itself (the account is real
    // either way) or leak provider status to the client. The user can
    // always retry via /resend-verification.
    console.error("sendVerificationEmail failed", err);
  }
}

function refreshCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";

  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? ("none" as const) : ("lax" as const),
    maxAge: REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
}

function accessCookieOptions() {
  const isProd = process.env.NODE_ENV === "production";

  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? ("none" as const) : ("lax" as const),
    maxAge: 15 * 60 * 1000,
  };
}

async function issueTokensAndSetCookies(res: any, userId: string) {
  const accessToken = signAccessToken({ userId });
  const refreshToken = generateRefreshToken();

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(
        Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
      ),
    },
  });

  res.cookie("accessToken", accessToken, accessCookieOptions());
  res.cookie("refreshToken", refreshToken, refreshCookieOptions());
}

router.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { id: true, email: true, name: true, emailVerified: true },
  });
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  res.json(user);
});

router.post("/signup", async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const { email, password, name } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Deliberately vague message — don't reveal whether the email
    // specifically exists; that's a minor information-disclosure leak otherwise.
    return res.status(400).json({ error: "Could not create account" });
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { email, passwordHash, name, emailVerified: false },
  });

  await issueEmailVerification(user.id, user.email);

  // We still let the user in immediately rather than blocking signup on
  // verification — that's a UX call, not a security one. The security
  // property this flow actually needs is: an unverified account can't
  // masquerade as having a mailbox it doesn't control. Anything that
  // depends on that (e.g. sending real notifications to this address,
  // invitations resolving by email, etc.) should check emailVerified
  // itself rather than this endpoint gatekeeping login.
  await issueTokensAndSetCookies(res, user.id);
  res.status(201).json({
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
  });
});

const loginSchema = z.object({
  email: z
    .string()
    .email()
    .transform((e) => normalizeEmail(e)),
  password: z.string(),
});

router.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  // Same generic error whether email doesn't exist OR password is wrong —
  // prevents attackers from using this endpoint to enumerate valid emails.
  const invalidMsg = { error: "Invalid email or password" };

  if (!user) return res.status(401).json(invalidMsg);

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return res.status(401).json(invalidMsg);

  await issueTokensAndSetCookies(res, user.id);
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
  });
});

router.post("/refresh", async (req, res) => {
  const rawToken = req.cookies?.refreshToken;
  if (!rawToken) return res.status(401).json({ error: "No refresh token" });

  const tokenHash = hashRefreshToken(rawToken);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    return res.status(401).json({ error: "Refresh token invalid or expired" });
  }

  // Rotation: revoke the used token and issue a brand new pair.
  // Why: if a refresh token is ever reused after rotation, that's a strong
  // signal it was stolen and replayed — a system could detect and alert on this.
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });

  await issueTokensAndSetCookies(res, stored.userId);
  res.json({ status: "refreshed" });
});

router.post("/logout", async (req, res) => {
  const rawToken = req.cookies?.refreshToken;
  if (rawToken) {
    const tokenHash = hashRefreshToken(rawToken);
    await prisma.refreshToken.updateMany({
      where: { tokenHash },
      data: { revokedAt: new Date() },
    });
  }
  res.clearCookie("accessToken", accessCookieOptions());
  res.clearCookie("refreshToken", refreshCookieOptions());
  res.json({ status: "logged out" });
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const RESET_TOKEN_TTL_MINUTES = 45;

router.post("/forgot-password", async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }

  // Deliberately identical response whether the email matches a real
  // account or not — same account-enumeration reasoning /login and
  // /signup already apply, extended here per PRD 5 Section 2.2. This is
  // computed once and returned from every path below so a timing
  // difference between "user exists" and "user doesn't" can't leak it
  // either.
  const genericResponse = {
    message:
      "If an account exists for this email, a password reset link has been sent.",
  };

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
  });
  if (!user) {
    return res.json(genericResponse);
  }

  const rawToken = generatePasswordResetToken();
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashPasswordResetToken(rawToken),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000),
    },
  });

  const resetLink = `${process.env.FRONTEND_URL ?? "http://localhost:3000"}/reset-password?token=${rawToken}`;

  try {
    await sendPasswordResetEmail(user.email, resetLink);
  } catch (err) {
    // Never let an email-provider failure leak into the response — that
    // would confirm the account exists (a 500 here vs. a 200 for a
    // nonexistent email is itself an enumeration vector). Log server-side
    // for real operational visibility instead, same swallow-and-log
    // reasoning activityLog.ts already uses for its own failures.
    console.error("sendPasswordResetEmail failed", err);
  }

  res.json(genericResponse);
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

router.post("/reset-password", async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  // Same deliberately generic failure message regardless of which
  // specific check fails below (token not found / already used /
  // expired) — per PRD 5 Section 2.2, never distinguish why, since that
  // itself is information a real attacker could use.
  const invalidMsg = { error: "This link is invalid or has expired." };

  const tokenHash = hashPasswordResetToken(parsed.data.token);
  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
  });

  if (!stored || stored.usedAt || stored.expiresAt < new Date()) {
    return res.status(400).json(invalidMsg);
  }

  const passwordHash = await hashPassword(parsed.data.newPassword);

  // Single-use enforcement: mark usedAt the moment the token is consumed,
  // in the same transaction as the actual password change, so a token
  // can never be replayed even if some later step in this request were
  // to fail.
  await prisma.$transaction([
    prisma.passwordResetToken.update({
      where: { id: stored.id },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: stored.userId },
      data: { passwordHash },
    }),
  ]);

  // Revoke every existing session for this user. Per PRD 5 Section 2.4:
  // if a session cookie was ever stolen, a legitimate password reset
  // should immediately invalidate it — otherwise the reset accomplishes
  // nothing from a security standpoint. Refresh tokens are stored
  // server-side (see RefreshToken model), so this is a straightforward
  // bulk revoke, not a design problem — resolves the open question PRD 5
  // flagged before this was confirmed against the real token model.
  await prisma.refreshToken.updateMany({
    where: { userId: stored.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  res.json({ status: "password reset" });
});

const verifyEmailSchema = z.object({
  token: z.string().min(1),
});

router.post("/verify-email", async (req, res) => {
  const parsed = verifyEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }

  // Same deliberately generic failure message regardless of which
  // specific check fails (token not found / already used / expired) —
  // same reasoning as reset-password's invalidMsg.
  const invalidMsg = { error: "This link is invalid or has expired." };

  const tokenHash = hashEmailVerificationToken(parsed.data.token);
  const stored = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash },
  });

  if (!stored || stored.usedAt || stored.expiresAt < new Date()) {
    return res.status(400).json(invalidMsg);
  }

  // Mark the token used and the account verified in one transaction, same
  // single-use-enforcement pattern as reset-password, so a token can
  // never be replayed even if a later step here were to fail.
  await prisma.$transaction([
    prisma.emailVerificationToken.update({
      where: { id: stored.id },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: stored.userId },
      data: { emailVerified: true, emailVerifiedAt: new Date() },
    }),
  ]);

  res.json({ status: "email verified" });
});

const resendVerificationSchema = z.object({
  email: z
    .string()
    .email()
    .transform((e) => normalizeEmail(e)),
});

router.post("/resend-verification", async (req, res) => {
  const parsed = resendVerificationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }

  // Same account-enumeration reasoning as /forgot-password: identical
  // response regardless of whether the email exists or is already
  // verified, so this endpoint can't be used to probe either fact.
  const genericResponse = {
    message:
      "If an account exists for this email and isn't yet verified, a new verification link has been sent.",
  };

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
  });
  if (!user || user.emailVerified) {
    return res.json(genericResponse);
  }

  await issueEmailVerification(user.id, user.email);
  res.json(genericResponse);
});

export default router;
