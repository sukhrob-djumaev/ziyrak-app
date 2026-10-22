import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import jwt from "jsonwebtoken";

/** PLAN.md P3 — a password reset ends every session issued before it, and only those. */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { generateToken, verifyActiveToken, endAllSessions } from "@/lib/identity/auth";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";

let a: SeededBusiness;
let b: SeededBusiness;
beforeAll(async () => {
  a = await seedBusiness("session-cutoff-a");
  b = await seedBusiness("session-cutoff-b");
});
afterAll(async () => {
  await cleanupBusiness(a.businessId);
  await cleanupBusiness(b.businessId);
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("endAllSessions", () => {
  it("invalidates earlier tokens (including legacy ones without a jti) but not a later login", async () => {
    const old = generateToken(a.ownerUserId);
    const legacy = jwt.sign({ userId: a.ownerUserId }, process.env.JWT_SECRET ?? "test-jwt-secret-for-vitest-only", { expiresIn: "7d" });
    expect(await verifyActiveToken(old)).not.toBeNull();
    await wait(1100);
    await endAllSessions(a.ownerUserId);
    expect(await verifyActiveToken(old)).toBeNull();
    expect(await verifyActiveToken(legacy)).toBeNull();
    await wait(1100);
    expect(await verifyActiveToken(generateToken(a.ownerUserId))).not.toBeNull();
  });

  it("does not affect another account's sessions", async () => {
    const other = generateToken(b.ownerUserId);
    await wait(1100);
    await endAllSessions(a.ownerUserId);
    expect(await verifyActiveToken(other)).not.toBeNull();
  });

  it("an account that never reset keeps working", async () => {
    const t = generateToken(b.ownerUserId);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: b.ownerUserId } })).toMatchObject({ sessionsValidAfter: null });
    expect(await verifyActiveToken(t)).not.toBeNull();
  });
});
