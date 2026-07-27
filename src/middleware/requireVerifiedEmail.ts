import { Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { AuthedRequest } from "./requireAuth";

// Deliberately NOT applied globally, and NOT part of requireAuth itself.
// Signup/login stay unblocked for unverified users (see routes/auth.ts's
// issueEmailVerification comment) — verification here is opt-in per
// route, reserved for actions where an unverified (possibly fake/typo'd)
// email would let the user extend trust to someone else on the strength
// of an address they don't actually control. Concretely, that means:
//   - sending organization invitations (invitee trusts the inviter's
//     identity)
//   - becoming an org owner/admin (other members trust that role)
//   - receiving certain notifications (a bounced/fake address shouldn't
//     silently swallow anything time-sensitive)
//   - future billing/payment features (receipts, dunning emails, etc.)
//   - OAuth account linking (linking an external identity to an address
//     nobody's confirmed the user owns)
// Add it to a route by chaining it after requireAuth (and after
// requireRole/resolveOrgFromParam, if the route has those):
//
//   router.post("/some-trust-sensitive-route",
//     resolveOrgFromParam("organizationId"),
//     requireRole("ADMIN"),
//     requireVerifiedEmail,
//     handler,
//   );
export async function requireVerifiedEmail(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) {
  if (!req.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { emailVerified: true },
  });

  if (!user) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  if (!user.emailVerified) {
    return res.status(403).json({
      error: "Please verify your email address before doing this.",
      code: "EMAIL_NOT_VERIFIED",
    });
  }

  next();
}
