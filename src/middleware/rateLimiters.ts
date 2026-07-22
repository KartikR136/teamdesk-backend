import rateLimit from "express-rate-limit";

// Each auth-adjacent endpoint gets its own bucket instead of one shared
// "authLimiter". Why this matters: a shared bucket means a burst of
// legitimate signups (or a legitimate retry loop against /refresh) eats
// into the budget /login relies on for brute-force protection, and vice
// versa — the buckets protect against different abuse shapes and
// shouldn't silently tax each other. THREAT_MODEL.md/ROADMAP.md already
// name this as a known, deferred gap; this is that fix.

// Brute-force / credential-stuffing target. Tightest of the four, since
// this is the endpoint an attacker actually wants to hammer.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts, please try again later" },
});

// Account-enumeration / mass-account-creation target. Same window as
// login but tracked independently — a signup burst no longer eats into
// the login budget.
export const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many signup attempts, please try again later" },
});

// Refresh is on its own budget deliberately looser than login/signup:
// a legitimate single-page-app can call /refresh routinely as access
// tokens expire (every 15 minutes per tokens.ts), so this needs enough
// headroom for normal use while still bounding a refresh-token-replay
// brute-force attempt.
export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many refresh attempts, please try again later" },
});

// Looser general limiter — protects against abuse without disrupting normal use.
export const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Distinct, stricter bucket for password reset REQUESTS specifically
// (/forgot-password only — not /reset-password). Per PRD 5: an unlimited
// forgot-password endpoint is an email-bombing vector against any
// address you know, which is a different abuse shape than login/signup
// brute-forcing, and deserves its own budget rather than sharing (and
// quietly tightening) the one login already depends on.
export const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 requests per IP per hour — enough headroom for legitimate retries, still tight for abuse
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

// /reset-password gets its own light bucket too. Its real protection is
// the token's own unguessability (64 random bytes), short expiry (45 min),
// and single-use enforcement -- rate-limiting can't meaningfully add
// security against a token that can't be brute-forced regardless -- but a
// generous bucket still costs nothing and blocks trivial request flooding.
export const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});
