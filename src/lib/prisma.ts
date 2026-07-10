import { PrismaClient } from "@prisma/client";

// Single shared Prisma instance across the app.
// Why: creating a new PrismaClient per request exhausts DB connections
// under load — a real production bug, not a theoretical one.
export const prisma = new PrismaClient();
