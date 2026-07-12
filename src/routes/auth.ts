import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth";
import { hashPassword, verifyPassword } from "../lib/password";
import {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
} from "../lib/tokens";

const router = Router();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
});

const REFRESH_TOKEN_TTL_DAYS = 30;

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
    select: { id: true, email: true, name: true },
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
    data: { email, passwordHash, name },
  });

  await issueTokensAndSetCookies(res, user.id);
  res.status(201).json({ id: user.id, email: user.email, name: user.name });
});

const loginSchema = z.object({
  email: z.string().email(),
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
  res.json({ id: user.id, email: user.email, name: user.name });
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
  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");
  res.json({ status: "logged out" });
});

export default router;
