// No email provider is wired up yet — this is a deliberate, named gap,
// not a silent placeholder. PRD 5 explicitly defers choosing a provider
// (Resend/Postmark/SES/etc.) since it's an infrastructure/cost decision,
// not a product one. Until one exists, this logs the link to the server
// console in development so the reset flow is genuinely testable
// end-to-end locally, and refuses to silently pretend an email was sent
// in production — the same DEMO_MODE-style honesty this codebase already
// applies elsewhere (see app.ts / THREAT_MODEL.md).
export async function sendPasswordResetEmail(
  email: string,
  resetLink: string,
): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    // Fail loudly rather than silently succeed with nothing actually
    // delivered — a user who never receives their reset email with no
    // error logged anywhere is a much worse failure mode than a 500 that
    // shows up in monitoring immediately.
    if (!process.env.EMAIL_PROVIDER_CONFIGURED) {
      throw new Error(
        "sendPasswordResetEmail: no email provider is configured. " +
          "Set EMAIL_PROVIDER_CONFIGURED and implement real sending here " +
          "before enabling password reset in production.",
      );
    }
    // Real provider integration goes here once one is chosen.
    return;
  }

  // Development / test: log the link so the flow is testable end-to-end
  // without needing real email infrastructure.
  console.log(
    `\n[password reset] Would email ${email}:\n  ${resetLink}\n`,
  );
}
