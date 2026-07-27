// Format validation (zod's z.string().email()) only proves an address is
// *syntactically* well-formed — "asdf@asdf.com" and "a@b.co" both pass it
// even though neither is a mailbox anyone can receive mail at. This module
// adds the two cheap, dependency-free checks that catch most of the
// "obviously fake" signups before we even try emailing a verification
// link:
//   1. Normalize (trim + lowercase) so "Foo@Bar.com" and "foo@bar.com"
//      are treated as the same account and can't be used to bypass the
//      uniqueness check or create lookalike duplicate accounts.
//   2. Reject known disposable/throwaway-email domains, which are the
//      single biggest source of low-effort fake signups in practice.
//
// Neither of these proves the mailbox actually exists — the only real
// proof of that is the verification-link flow in routes/auth.ts, which
// this module supports but doesn't replace.

// Small, commonly-abused subset. Not exhaustive — treat as a first line
// of defense, not a complete disposable-domain database. Extend via
// DISPOSABLE_EMAIL_DOMAINS_EXTRA (comma-separated) without a code change
// if a fuller list is adopted later (e.g. via a maintained npm package).
const BASE_DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.info",
  "10minutemail.com",
  "10minutemail.net",
  "tempmail.com",
  "temp-mail.org",
  "throwawaymail.com",
  "yopmail.com",
  "trashmail.com",
  "getnada.com",
  "sharklasers.com",
  "dispostable.com",
  "mailnesia.com",
  "maildrop.cc",
  "fakeinbox.com",
  "mintemail.com",
  "mytrashmail.com",
  "spamgourmet.com",
]);

function loadExtraDomains(): Set<string> {
  const raw = process.env.DISPOSABLE_EMAIL_DOMAINS_EXTRA;
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  );
}

const DISPOSABLE_DOMAINS = new Set([
  ...BASE_DISPOSABLE_DOMAINS,
  ...loadExtraDomains(),
]);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return DISPOSABLE_DOMAINS.has(domain);
}
