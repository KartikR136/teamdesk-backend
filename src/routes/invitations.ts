import { Router } from "express";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth";
import {
  requireRole,
  OrgScopedRequest,
  invalidateMembershipCache,
} from "../middleware/requireRole";
import { resolveOrgFromParam } from "../lib/resolveOrgContext";
import {
  paginationQuerySchema,
  buildPaginationArgs,
  paginateResults,
} from "../lib/pagination";
import { logActivity, ActivityAction } from "../lib/activityLog";

const router = Router();
router.use(requireAuth);

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const createInvitationSchema = z.object({
  email: z.string().email(),
  role: z
    .enum(["ADMIN", "MANAGER", "MEMBER", "VIEWER"])
    .optional()
    .default("MEMBER"),
});

// POST /api/organizations/:organizationId/invitations
// ADMIN-only. Invites are keyed by email, not an existing userId — the
// invitee doesn't need an account yet ("Email placeholder architecture").
router.post(
  "/organizations/:organizationId/invitations",
  resolveOrgFromParam("organizationId"),
  requireRole("ADMIN"),
  async (req: OrgScopedRequest, res) => {
    const parsed = createInvitationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { email, role } = parsed.data;
    const organizationId = req.organizationId!;

    const existingMember = await prisma.membership.findFirst({
      where: { organizationId, user: { email } },
    });
    if (existingMember) {
      return res.status(400).json({ error: "This email is already a member" });
    }

    const existingPending = await prisma.invitation.findFirst({
      where: { organizationId, email, status: "PENDING" },
    });
    if (existingPending) {
      return res
        .status(400)
        .json({
          error: "There is already a pending invitation for this email",
        });
    }

    const invitation = await prisma.invitation.create({
      data: {
        email,
        role,
        token: crypto.randomBytes(32).toString("hex"),
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        organizationId,
        invitedById: req.userId!,
      },
    });

    await logActivity({
      organizationId,
      userId: req.userId!,
      action: ActivityAction.MEMBER_INVITED,
      metadata: { email, role },
    });

    res.status(201).json(invitation);
  },
);

// GET /api/organizations/:organizationId/invitations
// ADMIN-only. Lists pending invitations for the org (not accepted/rejected/
// expired history — that's a "nice to have" audit view, not needed here).
router.get(
  "/organizations/:organizationId/invitations",
  resolveOrgFromParam("organizationId"),
  requireRole("ADMIN"),
  async (req: OrgScopedRequest, res) => {
    const parsedQuery = paginationQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({ error: parsedQuery.error.flatten() });
    }

    let paginationArgs;
    try {
      paginationArgs = buildPaginationArgs(parsedQuery.data);
    } catch {
      return res.status(400).json({ error: "Invalid cursor" });
    }

    const invitations = await prisma.invitation.findMany({
      where: { organizationId: req.organizationId!, status: "PENDING" },
      ...paginationArgs,
    });

    const { data, hasNextPage, nextCursor } = paginateResults(
      invitations,
      parsedQuery.data.limit,
    );

    res.json({ data, hasNextPage, nextCursor });
  },
);

// GET /api/invitations/me
// The current user's own pending, unexpired invitations across ALL orgs.
// No org context/requireRole here — ownership is proven by email match,
// not org membership. Not paginated: this is a personal "invite inbox",
// expected to be small; adding cursor pagination here would be
// over-engineering for a list that's realistically never going to be long.
router.get("/invitations/me", async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const invitations = await prisma.invitation.findMany({
    where: {
      email: user.email,
      status: "PENDING",
      expiresAt: { gt: new Date() },
    },
    include: {
      organization: { select: { id: true, name: true, slug: true } },
    },
  });

  res.json(invitations);
});

async function loadOwnedPendingInvitation(
  req: AuthedRequest,
  res: import("express").Response,
  invitationId: string,
) {
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }

  const invitation = await prisma.invitation.findUnique({
    where: { id: invitationId },
  });

  if (!invitation) {
    res.status(404).json({ error: "Invitation not found" });
    return null;
  }

  // Ownership is proven by email match, not by any org-membership check —
  // an invitee has no membership yet, that's the whole point of an invite.
  if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
    res.status(403).json({ error: "This invitation does not belong to you" });
    return null;
  }

  if (invitation.status !== "PENDING") {
    res
      .status(400)
      .json({ error: `Invitation already ${invitation.status.toLowerCase()}` });
    return null;
  }

  if (invitation.expiresAt < new Date()) {
    await prisma.invitation.update({
      where: { id: invitationId },
      data: { status: "EXPIRED" },
    });
    res.status(410).json({ error: "Invitation has expired" });
    return null;
  }

  return { user, invitation };
}

// POST /api/invitations/:invitationId/accept
router.post(
  "/invitations/:invitationId/accept",
  async (req: AuthedRequest, res) => {
    const invitationId = req.params.invitationId;
    if (typeof invitationId !== "string") {
      return res.status(400).json({ error: "Invalid invitation id" });
    }

    const loaded = await loadOwnedPendingInvitation(req, res, invitationId);
    if (!loaded) return; // response already sent by the helper
    const { user, invitation } = loaded;

    const existingMembership = await prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: user.id,
          organizationId: invitation.organizationId,
        },
      },
    });
    if (existingMembership) {
      return res
        .status(400)
        .json({ error: "Already a member of this organization" });
    }

    const [membership] = await prisma.$transaction([
      prisma.membership.create({
        data: {
          userId: user.id,
          organizationId: invitation.organizationId,
          role: invitation.role,
        },
      }),
      prisma.invitation.update({
        where: { id: invitationId },
        data: { status: "ACCEPTED" },
      }),
    ]);

    // Closes the M4 gap: a prior 403 lookup for this (userId, organizationId)
    // pair may have cached a NEGATIVE ("not a member") result for up to 60s.
    // Without this, a just-accepted invitee could still get 403'd on org
    // routes right after accepting, until that cache entry expired.
    await invalidateMembershipCache(user.id, invitation.organizationId);

    await logActivity({
      organizationId: invitation.organizationId,
      userId: user.id,
      action: ActivityAction.MEMBER_JOINED,
      metadata: { role: invitation.role },
    });

    res.status(201).json(membership);
  },
);

// POST /api/invitations/:invitationId/reject
router.post(
  "/invitations/:invitationId/reject",
  async (req: AuthedRequest, res) => {
    const invitationId = req.params.invitationId;
    if (typeof invitationId !== "string") {
      return res.status(400).json({ error: "Invalid invitation id" });
    }

    const loaded = await loadOwnedPendingInvitation(req, res, invitationId);
    if (!loaded) return;
    const { invitation } = loaded;

    await prisma.invitation.update({
      where: { id: invitationId },
      data: { status: "REJECTED" },
    });

    res.status(200).json({ status: "REJECTED" });
  },
);

export default router;
