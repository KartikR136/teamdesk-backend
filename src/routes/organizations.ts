import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthedRequest } from "../middleware/requireAuth";

const router = Router();

router.use(requireAuth);

const createOrgSchema = z.object({
  name: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "lowercase letters, numbers, hyphens only"),
});

// Creating an org has no existing org to check membership against yet —
// this is the one case where there's no requireRole; the creator becomes ADMIN.
router.post("/", async (req: AuthedRequest, res) => {
  const parsed = createOrgSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const existingSlug = await prisma.organization.findUnique({
    where: { slug: parsed.data.slug },
  });
  if (existingSlug) {
    return res.status(400).json({ error: "Slug already taken" });
  }

  const org = await prisma.organization.create({
    data: {
      name: parsed.data.name,
      slug: parsed.data.slug,
      memberships: {
        create: { userId: req.userId!, role: "ADMIN" },
      },
    },
  });

  res.status(201).json(org);
});

// List orgs the current user belongs to.
router.get("/", async (req: AuthedRequest, res) => {
  const memberships = await prisma.membership.findMany({
    where: { userId: req.userId! },
    include: { organization: true },
  });
  res.json(memberships.map((m) => ({ ...m.organization, role: m.role })));
});

export default router;
