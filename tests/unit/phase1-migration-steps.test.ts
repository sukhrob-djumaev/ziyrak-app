import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { EnvKeySecretResolver } from "@/lib/secrets/env-key-resolver";
import {
  TENANT_TABLES,
  ensureDefaultBusiness,
  migrateAdminsToUsersAndMemberships,
  splitSettingsIntoBusinessConfigAndChannelConnections,
  invalidateExistingApiKeys,
  verifyNoNullBusinessId,
  backfillBusinessId,
} from "../../scripts/phase1-migration-steps";

/**
 * §13.4's migration-verification suite, plus the specific "editor"-role
 * regression test PLAN.md §13.2 step 8 calls for. These exercise the actual
 * migration script's logic (not a reimplementation of it) against a fake,
 * in-memory Prisma client — the same mocking style the rest of this suite
 * uses — rather than a live database, since Settings/Admin are process-wide
 * singletons in the pre-migration schema and can't be sandboxed per test
 * against a real Postgres without colliding with each other.
 */

function fakePrisma(overrides: Record<string, unknown> = {}): PrismaClient {
  const base = {
    admin: { findMany: vi.fn().mockResolvedValue([]) },
    user: { upsert: vi.fn() },
    membership: { upsert: vi.fn() },
    business: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    settings: { findUnique: vi.fn().mockResolvedValue(null) },
    businessConfig: { upsert: vi.fn() },
    channel: { findMany: vi.fn().mockResolvedValue([]) },
    channelConnection: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    apiKey: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ count: BigInt(0) }]),
    $queryRaw: vi.fn().mockResolvedValue([{ count: BigInt(0) }]),
  };
  return { ...base, ...overrides } as unknown as PrismaClient;
}

describe("migrateAdminsToUsersAndMemberships", () => {
  it("assigns the earliest-created admin the owner role", async () => {
    const admins = [{ id: "a1", username: "first", password: "hash1", name: "First", createdAt: new Date("2026-01-01") }];
    const prisma = fakePrisma({
      admin: { findMany: vi.fn().mockResolvedValue(admins) },
      user: { upsert: vi.fn().mockResolvedValue({ id: "a1" }) },
      membership: { upsert: vi.fn() },
    });

    await migrateAdminsToUsersAndMemberships(prisma, "biz1", () => {});

    expect(prisma.membership.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ role: "owner", businessId: "biz1", userId: "a1" }) })
    );
    expect(prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ password: "hash1" }) })
    );
  });

  it("maps a later admin's valid role straight through, not to owner", async () => {
    const admins = [
      { id: "a1", username: "first", password: "h1", name: "First", createdAt: new Date("2026-01-01") },
      { id: "a2", username: "second", password: "h2", name: "Second", role: "supervisor", createdAt: new Date("2026-01-02") },
    ];
    const prisma = fakePrisma({
      admin: { findMany: vi.fn().mockResolvedValue(admins) },
      user: { upsert: vi.fn().mockImplementation(({ create }) => Promise.resolve({ id: create.id })) },
      membership: { upsert: vi.fn() },
    });

    await migrateAdminsToUsersAndMemberships(prisma, "biz1", () => {});

    const calls = (prisma.membership.upsert as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].create.role).toBe("owner");
    expect(calls[1][0].create.role).toBe("supervisor");
  });

  it("downgrades a non-standard role (the §2.4 'editor' bug) to viewer and flags it for review, without throwing", async () => {
    const admins = [
      { id: "a1", username: "first", password: "h1", name: "First", createdAt: new Date("2026-01-01") },
      { id: "a2", username: "second", password: "h2", name: "Second", role: "editor", createdAt: new Date("2026-01-02") },
    ];
    const prisma = fakePrisma({
      admin: { findMany: vi.fn().mockResolvedValue(admins) },
      user: { upsert: vi.fn().mockImplementation(({ create }) => Promise.resolve({ id: create.id })) },
      membership: { upsert: vi.fn() },
    });
    const logs: string[] = [];

    await expect(migrateAdminsToUsersAndMemberships(prisma, "biz1", (m) => logs.push(m))).resolves.not.toThrow();

    const calls = (prisma.membership.upsert as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[1][0].create.role).toBe("viewer");
    expect(logs.some((l) => l.includes("FLAGGED FOR REVIEW") && l.includes("editor"))).toBe(true);
  });
});

describe("ensureDefaultBusiness", () => {
  it("returns the existing business without creating a duplicate", async () => {
    const existing = { id: "biz1", slug: "default" };
    const prisma = fakePrisma({ business: { findUnique: vi.fn().mockResolvedValue(existing), create: vi.fn() } });

    const result = await ensureDefaultBusiness(prisma);

    expect(result).toBe(existing);
    expect(prisma.business.create).not.toHaveBeenCalled();
  });

  it("names the new business from Settings.businessName when present", async () => {
    const prisma = fakePrisma({
      business: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "biz1" }) },
      settings: { findUnique: vi.fn().mockResolvedValue({ businessName: "Acme Support" }) },
    });

    await ensureDefaultBusiness(prisma);

    expect(prisma.business.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "Acme Support" }) })
    );
  });

  it("falls back to a generic name when there is no pre-existing Settings row", async () => {
    const prisma = fakePrisma({
      business: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "biz1" }) },
    });

    await ensureDefaultBusiness(prisma);

    expect(prisma.business.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "Default Business" }) })
    );
  });
});

describe("splitSettingsIntoBusinessConfigAndChannelConnections", () => {
  const resolver = new EnvKeySecretResolver({ SECRET_KEY_V1: "test-key" } as unknown as NodeJS.ProcessEnv);

  it("does nothing when there is no Settings row", async () => {
    const prisma = fakePrisma();
    await splitSettingsIntoBusinessConfigAndChannelConnections(prisma, "biz1", resolver, () => {});
    expect(prisma.businessConfig.upsert).not.toHaveBeenCalled();
  });

  it("copies Settings' non-secret fields into BusinessConfig verbatim", async () => {
    const settings = {
      businessName: "Acme",
      businessDesc: "desc",
      welcomeMessage: "hi",
      tone: "friendly",
      language: "en",
      aiProvider: "openai",
      aiModel: "gpt-4o-mini",
      maxTokens: 2048,
      temperature: 0.7,
      twilioSid: "",
      twilioToken: "",
      twilioPhone: "",
      smtpHost: "",
      telegramBotToken: "",
      whatsappApiKey: "",
      whatsappMode: "web",
    };
    const prisma = fakePrisma({ settings: { findUnique: vi.fn().mockResolvedValue(settings) } });

    await splitSettingsIntoBusinessConfigAndChannelConnections(prisma, "biz1", resolver, () => {});

    expect(prisma.businessConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          businessId: "biz1",
          businessName: "Acme",
          aiProvider: "openai",
          aiModel: "gpt-4o-mini",
        }),
      })
    );
  });

  it("creates a ChannelConnection with an encrypted, round-trippable credentialRef for a configured Twilio channel", async () => {
    const settings = {
      businessName: "Acme",
      businessDesc: "",
      welcomeMessage: "",
      tone: "friendly",
      language: "en",
      aiProvider: null,
      aiModel: null,
      maxTokens: null,
      temperature: null,
      twilioSid: "AC123",
      twilioToken: "secret-token",
      twilioPhone: "+15550001111",
      smtpHost: "",
      telegramBotToken: "",
      whatsappApiKey: "",
      whatsappMode: "web",
    };
    let created: Record<string, unknown> | undefined;
    const prisma = fakePrisma({
      settings: { findUnique: vi.fn().mockResolvedValue(settings) },
      channelConnection: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(({ data }) => {
          created = data;
          return Promise.resolve(data);
        }),
      },
    });

    await splitSettingsIntoBusinessConfigAndChannelConnections(prisma, "biz1", resolver, () => {});

    expect(created).toBeDefined();
    expect(created!.type).toBe("phone");
    const encrypted = JSON.parse(created!.credentialRef as string);
    const decrypted = JSON.parse(await resolver.decrypt(encrypted));
    expect(decrypted).toEqual({
      type: "phone",
      accountSid: "AC123",
      authToken: "secret-token",
      phoneNumber: "+15550001111",
    });
  });

  it("skips a channel entirely when neither a credential nor an old Channel row exists", async () => {
    const settings = {
      businessName: "Acme",
      businessDesc: "",
      welcomeMessage: "",
      tone: "friendly",
      language: "en",
      aiProvider: null,
      aiModel: null,
      maxTokens: null,
      temperature: null,
      twilioSid: "",
      twilioToken: "",
      twilioPhone: "",
      smtpHost: "",
      telegramBotToken: "",
      whatsappApiKey: "",
      whatsappMode: "web",
    };
    const prisma = fakePrisma({ settings: { findUnique: vi.fn().mockResolvedValue(settings) } });

    await splitSettingsIntoBusinessConfigAndChannelConnections(prisma, "biz1", resolver, () => {});

    expect(prisma.channelConnection.create).not.toHaveBeenCalled();
  });
});

describe("invalidateExistingApiKeys", () => {
  it("marks every pre-existing key revoked, inactive, and unmatchable, never dropping the row", async () => {
    const prisma = fakePrisma({
      apiKey: { update: vi.fn() },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "key1", name: "Old Integration" }]),
    });

    await invalidateExistingApiKeys(prisma, "biz1", () => {});

    expect(prisma.apiKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "key1" },
        data: expect.objectContaining({ businessId: "biz1", isActive: false, role: "agent" }),
      })
    );
    const data = (prisma.apiKey.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data.revokedAt).toBeInstanceOf(Date);
    expect(typeof data.keyHash).toBe("string");
    expect(data.keyHash.length).toBeGreaterThan(0);
  });

  it("does nothing when there are no pre-existing keys", async () => {
    const prisma = fakePrisma({ $queryRaw: vi.fn().mockResolvedValue([]) });
    await invalidateExistingApiKeys(prisma, "biz1", () => {});
    expect(prisma.apiKey.update).not.toHaveBeenCalled();
  });
});

describe("backfillBusinessId", () => {
  it("issues one UPDATE per tenant table with the given businessId", async () => {
    const prisma = fakePrisma();
    await backfillBusinessId(prisma, "biz1", () => {});
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(TENANT_TABLES.length);
    for (const call of (prisma.$executeRawUnsafe as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).toBe("biz1");
    }
  });
});

describe("verifyNoNullBusinessId", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("passes silently when every table reports zero NULLs", async () => {
    const prisma = fakePrisma();
    await expect(verifyNoNullBusinessId(prisma, () => {})).resolves.not.toThrow();
  });

  it("throws, naming the offending table, when a table still has a NULL businessId", async () => {
    const prisma = fakePrisma({
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ count: BigInt(3) }]),
    });

    await expect(verifyNoNullBusinessId(prisma, () => {})).rejects.toThrow(/Category/);
  });

  it("throws when ApiKey still has a NULL businessId", async () => {
    const prisma = fakePrisma({
      $queryRaw: vi.fn().mockResolvedValue([{ count: BigInt(1) }]),
    });

    await expect(verifyNoNullBusinessId(prisma, () => {})).rejects.toThrow(/ApiKey/);
  });
});
