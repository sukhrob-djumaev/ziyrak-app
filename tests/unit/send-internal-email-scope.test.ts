import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/**
 * P1: `send_internal_email` sends through the legacy GLOBAL SMTP row. Only the default (first)
 * business may configure that row, so only it may use it; every other workspace gets "not
 * configured" instead of mail sent from another party's account.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());
// Use the real default-business guard here; the global test setup replaces it with a stub.
vi.mock("@/lib/tenancy/default-business", async (importOriginal) => importOriginal());
const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn(async () => ({}));
  return { sendMail, createTransport: vi.fn(() => ({ sendMail })) };
});
vi.mock("nodemailer", () => ({ default: { createTransport }, createTransport }));

import { prisma } from "@/lib/prisma/raw-client";
import { sendInternalEmailTool } from "@/lib/tools/builtin/send-internal-email";
import {
  seedBusiness,
  findOrCreateDefaultBusiness,
  cleanupBusiness,
  type SeededBusiness,
} from "../helpers/tenant-fixtures";

let other: SeededBusiness;
let defaultBusiness: SeededBusiness;
let previous: Awaited<ReturnType<typeof prisma.settings.findFirst>>;

beforeAll(async () => {
  defaultBusiness = await findOrCreateDefaultBusiness();
  other = await seedBusiness("internal-email-scope");
  previous = await prisma.settings.findFirst();
  await prisma.settings.upsert({
    where: { id: previous?.id ?? "default" },
    update: { smtpHost: "smtp.example.invalid", smtpPort: 587, smtpUser: "u", smtpPass: "p" },
    create: {
      id: "default",
      smtpHost: "smtp.example.invalid",
      smtpPort: 587,
      smtpUser: "u",
      smtpPass: "p",
    },
  });
});
afterAll(async () => {
  if (previous)
    await prisma.settings.update({
      where: { id: previous.id },
      data: {
        smtpHost: previous.smtpHost,
        smtpUser: previous.smtpUser,
        smtpPass: previous.smtpPass,
      },
    });
  else await prisma.settings.deleteMany({ where: { id: "default" } });
  await cleanupBusiness(other.businessId);
});

const args = { to: "someone@example.invalid", subject: "s", body: "b" };

describe("send_internal_email and the global SMTP account", () => {
  it("does not send for a workspace other than the default one", async () => {
    createTransport.mockClear();
    sendMail.mockClear();
    const result = await sendInternalEmailTool.execute(other.ctx, args, {});
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not configured/i);
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("still sends for the default workspace that owns the global SMTP settings", async () => {
    createTransport.mockClear();
    sendMail.mockClear();
    const result = await sendInternalEmailTool.execute(defaultBusiness.ctx, args, {});
    expect(result.success).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
