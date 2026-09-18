/**
 * Phase 1 tenant migration steps (PLAN.md §46.1, §13.2 steps 2-3 and 7-10),
 * factored out as pure functions taking an explicit Prisma client so they can
 * be exercised directly by tests/migration/phase1-tenant-migration.test.ts
 * (§13.4's verification suite) against a scratch business, independent of
 * `scripts/phase1-tenant-migration.ts`'s CLI wrapper.
 *
 * Every step is a create-if-missing/update-where-null operation — safe to
 * re-run after a partial failure.
 */

import crypto from "crypto";
import type { PrismaClient } from "../src/generated/prisma/client";
import { ROLES } from "../src/lib/rbac/rbac";
import type { SecretResolver } from "../src/lib/secrets/types";
import { ChannelCredentialSchema } from "../src/lib/secrets/credential-schemas";

export const DEFAULT_BUSINESS_SLUG = "default";

// Every existing tenant-owned table that gained a nullable `businessId`
// column in the expand-step migrations. BusinessHours is included here
// deliberately: its singleton row is backfilled in place (same row, same
// "default" id) rather than duplicated into a new row, since it is not
// splitting into multiple destination tables the way Settings is.
export const TENANT_TABLES = [
  "Category",
  "KnowledgeEntry",
  "Department",
  "TeamMember",
  "Customer",
  "CustomerNote",
  "Conversation",
  "Message",
  "Ticket",
  "Tag",
  "ConversationTag",
  "InternalNote",
  "CallLog",
  "Schedule",
  "Webhook",
  "WebhookDelivery",
  "ActivityLog",
  "SLARule",
  "CannedResponse",
  "AutomationRule",
  "Campaign",
  "Flow",
  "BusinessHours",
] as const;

export async function ensureDefaultBusiness(prisma: PrismaClient, slug: string = DEFAULT_BUSINESS_SLUG) {
  const existing = await prisma.business.findUnique({ where: { slug } });
  if (existing) return existing;

  const settings = await prisma.settings.findUnique({ where: { id: "default" } });
  const name = settings?.businessName?.trim() || "Default Business";

  return prisma.business.create({
    data: { slug, name, status: "active" },
  });
}

export async function ensureTenantPlacement(prisma: PrismaClient, businessId: string) {
  await prisma.tenantPlacement.upsert({
    where: { businessId },
    update: {},
    create: { businessId },
  });
}

/**
 * §13.2 step 8: every existing Admin row becomes a User + Membership. The
 * earliest-created Admin (whoever set up the instance first) becomes the
 * business's "owner"; every other Admin's role maps through rbac.ts's real
 * ROLES, downgrading to "viewer" for any non-standard value (the §2.4
 * "editor" bug included) — logged for manual review, not silently dropped.
 */
export async function migrateAdminsToUsersAndMemberships(
  prisma: PrismaClient,
  businessId: string,
  log: (message: string) => void = console.log
) {
  const admins = await prisma.admin.findMany({ orderBy: { createdAt: "asc" } });
  if (admins.length === 0) {
    log("No existing Admin rows — nothing to migrate to User/Membership.\n");
    return;
  }

  log(`Migrating ${admins.length} Admin row(s) to User + Membership...`);
  for (const [index, admin] of admins.entries()) {
    const isEarliest = index === 0;
    let role: string;
    if (isEarliest) {
      role = "owner";
    } else if ((ROLES as readonly string[]).includes(admin.role)) {
      role = admin.role;
    } else {
      role = "viewer";
      log(
        `  FLAGGED FOR REVIEW: Admin ${admin.id} (${admin.username}) had non-standard role "${admin.role}" — downgraded to "viewer" per §13.2 step 8.`
      );
    }

    const user = await prisma.user.upsert({
      where: { username: admin.username },
      update: {},
      create: {
        id: admin.id, // preserved for audit traceability during the migration window; not relied on anywhere
        username: admin.username,
        password: admin.password, // bcrypt hash carried bit-for-bit, never re-hashed
        name: admin.name,
      },
    });

    await prisma.membership.upsert({
      where: { businessId_userId: { businessId, userId: user.id } },
      update: {},
      create: { businessId, userId: user.id, role },
    });

    log(`  ${admin.username} -> User ${user.id}, Membership role="${role}"`);
  }
  log("");
}

/** §13.2 step 3: backfill businessId on every existing tenant table. */
export async function backfillBusinessId(
  prisma: PrismaClient,
  businessId: string,
  log: (message: string) => void = console.log
) {
  log("Backfilling businessId across existing tables...");
  for (const table of TENANT_TABLES) {
    const updated = await prisma.$executeRawUnsafe(
      `UPDATE "${table}" SET "businessId" = $1 WHERE "businessId" IS NULL`,
      businessId
    );
    if (updated > 0) log(`  ${table}: ${updated} row(s) backfilled`);
  }
  log("");
}

const CHANNEL_NAMES: Record<string, string> = {
  whatsapp: "WhatsApp",
  email: "Email",
  phone: "Phone (Twilio)",
  sms: "SMS (Twilio)",
  telegram: "Telegram",
  webchat: "Web Chat",
};

/**
 * §13.2 step 7 + the ChannelConnection half of §7.7 (not itself a numbered
 * migration step in §13.2, but the only coherent reading of "ChannelConnection
 * replaces Channel entirely" — see the Phase 1 kickoff report for why this
 * fold-in was necessary): Settings' non-secret fields become BusinessConfig;
 * each configured channel's secrets (from Settings) and status (from the old
 * Channel rows) become one ChannelConnection row per type.
 */
export async function splitSettingsIntoBusinessConfigAndChannelConnections(
  prisma: PrismaClient,
  businessId: string,
  resolver: SecretResolver,
  log: (message: string) => void = console.log
) {
  const settings = await prisma.settings.findUnique({ where: { id: "default" } });
  if (!settings) {
    log("No Settings row found — skipping BusinessConfig/ChannelConnection split.\n");
    return;
  }

  await prisma.businessConfig.upsert({
    where: { businessId },
    update: {},
    create: {
      businessId,
      businessName: settings.businessName,
      businessDesc: settings.businessDesc,
      welcomeMessage: settings.welcomeMessage,
      tone: settings.tone,
      language: settings.language,
      aiProvider: settings.aiProvider,
      aiModel: settings.aiModel,
      maxTokens: settings.maxTokens,
      temperature: settings.temperature,
    },
  });
  log("BusinessConfig created from Settings' non-secret fields.");
  log(
    "  NOTE: Settings.aiApiKey has no Phase 1 destination — BusinessConfig (§10.2) reserves no credential\n" +
      "  field for it, and it is not a ChannelConnection type. It remains readable only from the retained\n" +
      "  Settings row until Phase 4's AIProviderRegistry defines where AI provider credentials belong.\n"
  );

  const oldChannels = await prisma.channel.findMany();
  const channelByType = new Map(oldChannels.map((c) => [c.type, c]));

  const credentialByType = new Map<string, Record<string, unknown>>();
  if (settings.twilioSid || settings.twilioToken || settings.twilioPhone) {
    credentialByType.set("phone", {
      type: "phone",
      accountSid: settings.twilioSid,
      authToken: settings.twilioToken,
      phoneNumber: settings.twilioPhone,
    });
  }
  if (settings.smtpHost) {
    credentialByType.set("email", {
      type: "email",
      smtpHost: settings.smtpHost,
      smtpPort: settings.smtpPort,
      smtpUser: settings.smtpUser,
      smtpPass: settings.smtpPass,
      smtpFrom: settings.smtpFrom,
      ...(settings.imapHost
        ? {
            imapHost: settings.imapHost,
            imapPort: settings.imapPort,
            imapUser: settings.imapUser,
            imapPass: settings.imapPass,
          }
        : {}),
    });
  } else if (settings.imapHost) {
    log(
      "  MANUAL REVIEW: IMAP is configured without SMTP — EmailCredentialSchema requires SMTP fields. Skipped; migrate this connection by hand."
    );
  }
  if (settings.telegramBotToken) {
    credentialByType.set("telegram", { type: "telegram", botToken: settings.telegramBotToken });
  }
  // WhatsApp: today's `whatsappMode: "web"` is session-based (whatsapp-web.js +
  // Puppeteer LocalAuth) with no API credential to encrypt — that only exists
  // for the future Meta Cloud API adapter (§20, Phase 5). A legacy
  // whatsappApiKey doesn't map onto MetaWhatsAppCredentialSchema's shape
  // (phoneNumberId/accessToken/businessAccountId), so it's flagged, not
  // force-fit into the wrong schema.
  if (settings.whatsappApiKey) {
    log(
      "  MANUAL REVIEW: legacy whatsappApiKey is set but does not map onto MetaWhatsAppCredentialSchema — migrate this connection by hand when the Meta adapter (Phase 5) is built."
    );
  }

  // One ChannelConnection per channel type that is either configured with a
  // real credential above, or already has a Channel row today (i.e. appears
  // in the current dashboard) — §10.4's "one default connection per
  // configured channel", read to include "configured" in the UI-presence
  // sense, not only the credential sense.
  const typesToMigrate = new Set<string>([...channelByType.keys(), ...credentialByType.keys()]);

  for (const type of typesToMigrate) {
    const existing = await prisma.channelConnection.findFirst({ where: { businessId, type } });
    if (existing) continue;

    const oldChannel = channelByType.get(type);
    const credential = credentialByType.get(type);
    let credentialRef: string | null = null;

    if (credential) {
      const parsed = ChannelCredentialSchema.safeParse(credential);
      if (!parsed.success) {
        log(
          `  SKIPPED "${type}": credential failed validation (${parsed.error.issues.map((i) => i.message).join(", ")}) — review manually.`
        );
        continue;
      }
      const encrypted = await resolver.encrypt(JSON.stringify(parsed.data));
      credentialRef = JSON.stringify(encrypted);
    }

    await prisma.channelConnection.create({
      data: {
        businessId,
        type,
        name: CHANNEL_NAMES[type] ?? type,
        isActive: oldChannel?.isActive ?? false,
        status: oldChannel?.status ?? "disconnected",
        config: type === "whatsapp" ? { mode: settings.whatsappMode } : {},
        credentialRef,
      },
    });
    log(`  ChannelConnection created for "${type}"${credentialRef ? " (credential encrypted)" : " (no credential to migrate)"}.`);
  }
  log("");
}

/**
 * §13.2 step 10: existing ApiKey rows cannot be transparently rehashed into
 * the new scheme — see the Phase 1 kickoff report for why this plan invalidates
 * rather than silently rehashing the plaintext this migration still has
 * access to. Every invalidated key is logged by name/id, never silently
 * dropped, so an operator can issue replacements.
 *
 * Uses raw SQL rather than a typed Prisma filter because this is only ever
 * meaningful during the brief window between the ApiKey expand-step
 * migration (keyHash added, nullable) and the contract-step migration
 * (keyHash made NOT NULL); once contracted, keyHash can never be NULL at
 * the database level, so this always finds zero rows post-contract — a raw
 * query expresses that "permanently zero after this point" query shape
 * without fighting Prisma's generated types for a column that is validly
 * NOT NULL as of this schema version.
 */
export async function invalidateExistingApiKeys(
  prisma: PrismaClient,
  businessId: string,
  log: (message: string) => void = console.log
) {
  const keys = await prisma.$queryRaw<Array<{ id: string; name: string }>>`
    SELECT id, name FROM "ApiKey" WHERE "keyHash" IS NULL
  `;
  if (keys.length === 0) {
    log("No pre-existing ApiKey rows to invalidate.\n");
    return;
  }

  log(`Invalidating ${keys.length} pre-existing ApiKey row(s) (plaintext keys cannot carry forward):`);
  for (const key of keys) {
    const unmatchableHash = crypto.randomBytes(32).toString("hex");
    await prisma.apiKey.update({
      where: { id: key.id },
      data: {
        businessId,
        keyPrefix: `invalidated_${key.id.slice(0, 8)}`,
        keyHash: unmatchableHash,
        role: "agent",
        revokedAt: new Date(),
        isActive: false,
      },
    });
    log(`  INVALIDATED: ApiKey ${key.id} ("${key.name}") — issue a replacement key.`);
  }
  log("");
}

/** §13.2 step 4: refuse to proceed if any table still has a NULL businessId. */
export async function verifyNoNullBusinessId(prisma: PrismaClient, log: (message: string) => void = console.log) {
  log("Verifying no NULL businessId remains...");
  const failures: string[] = [];
  for (const table of TENANT_TABLES) {
    const [{ count }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM "${table}" WHERE "businessId" IS NULL`
    );
    if (count > BigInt(0)) failures.push(`${table} (${count} row(s))`);
  }
  const [{ count: apiKeyNulls }] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM "ApiKey" WHERE "businessId" IS NULL
  `;
  if (apiKeyNulls > BigInt(0)) failures.push(`ApiKey (${apiKeyNulls} row(s))`);

  if (failures.length > 0) {
    throw new Error(
      `Verification failed: NULL businessId remains in ${failures.join(", ")}. Refusing to proceed — see PLAN.md §13.2 step 4.`
    );
  }
  log("  OK — zero NULL businessId values across all tenant tables.\n");
}

export async function runPhase1TenantMigration(
  prisma: PrismaClient,
  resolver: SecretResolver,
  log: (message: string) => void = console.log
) {
  log("=== Phase 1 tenant migration (PLAN.md §46.1) ===\n");

  const business = await ensureDefaultBusiness(prisma);
  log(`Default Business: ${business.id} (slug="${business.slug}", name="${business.name}")\n`);

  await ensureTenantPlacement(prisma, business.id);
  await migrateAdminsToUsersAndMemberships(prisma, business.id, log);
  await backfillBusinessId(prisma, business.id, log);
  await splitSettingsIntoBusinessConfigAndChannelConnections(prisma, business.id, resolver, log);
  await invalidateExistingApiKeys(prisma, business.id, log);
  await verifyNoNullBusinessId(prisma, log);

  log("=== Phase 1 tenant migration complete ===");
  return business;
}
