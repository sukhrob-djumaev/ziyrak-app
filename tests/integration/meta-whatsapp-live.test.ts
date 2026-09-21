import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import crypto from "crypto";

// Real Postgres (this file lives outside the default suite, which mocks the
// raw client globally) — the point is the real adapter, real credential
// storage, and the real Meta Graph API, end to end.
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { prisma } from "@/lib/prisma/raw-client";
import { provisionBusiness } from "@/lib/platform/provisioning";
import * as connectionsService from "@/lib/channels/connections-service";
import { metaCloudWhatsAppAdapter } from "@/lib/channels/meta-whatsapp-adapter";
import { cleanupBusiness } from "../helpers/tenant-fixtures";
import type { TenantContext } from "@/lib/tenancy/context";

/**
 * PLAN.md §34.2/§46.7 — the credential-gated, real-provider smoke suite for
 * MetaCloudWhatsAppAdapter, the counterpart of `ai-provider-live.test.ts`.
 * It lives under tests/integration/, which vitest.config.ts (what
 * `npm run test`/CI run) structurally excludes; the only way to run it is
 *
 *   META_TEST_PHONE_NUMBER_ID=... META_TEST_ACCESS_TOKEN=... \
 *   META_TEST_RECIPIENT=<digits, no +> npm run test:smoke:meta
 *
 * against a Meta *test* WhatsApp Business account (the free test phone number
 * Meta provisions with a developer app, plus a recipient number registered as
 * a test recipient). `describe.skipIf` below skips it cleanly, with no
 * network call, whenever any of the three is absent.
 *
 * What it proves against the real Graph API, through the same code path
 * production uses:
 *   1. Saving the credential through the connection service verifies, live,
 *      that the access token can read this exact phone_number_id (the
 *      ownership proof that stops one business claiming another's number),
 *      and that a bogus token for the same number is refused.
 *   2. `sendMessage` delivers a real WhatsApp message via the business's own
 *      number and token.
 *   3. `getStatus` reflects a configured, active connection.
 *
 * Deliberately NOT covered here, because it cannot be exercised without a
 * public HTTPS URL registered as the Meta App's webhook and a human sending
 * a real WhatsApp message to the test number: live *inbound* delivery. That
 * remains a manual acceptance step (see the report's remaining-issues list);
 * inbound signature/dedup/tenant resolution is covered deterministically by
 * tests/security/meta-whatsapp-webhook.test.ts and tests/e2e.
 *
 * Note on free-form text: WhatsApp only permits a non-template message to a
 * recipient who has messaged the business number within the last 24 hours
 * (Meta returns error 131047 otherwise). If step 2 fails for that reason,
 * message the test number from the recipient's WhatsApp first and re-run.
 *
 * Secrets are read once from the environment and are never logged, echoed,
 * or written anywhere; assertion failures print Meta's error body only.
 */
const PHONE_NUMBER_ID = process.env.META_TEST_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.META_TEST_ACCESS_TOKEN;
const RECIPIENT = process.env.META_TEST_RECIPIENT;
const BUSINESS_ACCOUNT_ID = process.env.META_TEST_BUSINESS_ACCOUNT_ID || "smoke-test-waba";

describe.skipIf(!PHONE_NUMBER_ID || !ACCESS_TOKEN || !RECIPIENT)("LIVE smoke test: MetaCloudWhatsAppAdapter -> real Meta Graph API (§46.7)", () => {
  let businessId: string;
  let ctx: TenantContext;
  let connectionId: string;
  const suffix = crypto.randomBytes(4).toString("hex");

  beforeAll(async () => {
    const provisioned = await provisionBusiness({ businessName: `Meta Smoke ${suffix}`, ownerUsername: `meta-smoke-${suffix}`, ownerPassword: "smoke-test-password" });
    businessId = provisioned.businessId;
    ctx = { businessId, role: "owner", actor: { kind: "user", userId: provisioned.userId }, dataConnection: "shared-default" };
  });

  afterAll(async () => {
    if (!businessId) return;
    const members = await prisma.membership.findMany({ where: { businessId }, select: { userId: true } });
    await cleanupBusiness(businessId);
    for (const m of members) await prisma.user.delete({ where: { id: m.userId } }).catch(() => {});
  });

  it("refuses a credential whose token cannot read the phone number, and accepts the real one", async () => {
    await expect(
      connectionsService.upsertByType(ctx, "whatsapp_cloud", {
        isActive: true,
        credential: { type: "whatsapp_cloud", phoneNumberId: PHONE_NUMBER_ID!, accessToken: "definitely-not-a-valid-token", businessAccountId: BUSINESS_ACCOUNT_ID },
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    const saved = await connectionsService.upsertByType(ctx, "whatsapp_cloud", {
      isActive: true,
      status: "connected",
      credential: { type: "whatsapp_cloud", phoneNumberId: PHONE_NUMBER_ID!, accessToken: ACCESS_TOKEN!, businessAccountId: BUSINESS_ACCOUNT_ID },
    });
    connectionId = saved.id;
    expect((saved.config as { phoneNumberId: string }).phoneNumberId).toBe(PHONE_NUMBER_ID);
  });

  it("reports the connection as connected", async () => {
    const status = await metaCloudWhatsAppAdapter.getStatus(ctx, connectionId);
    expect(status.connected).toBe(true);
  });

  it("sends a real WhatsApp message through the business's own number and token", async () => {
    const result = await metaCloudWhatsAppAdapter.sendMessage(ctx, connectionId, RECIPIENT!, {
      text: `Ziyrak smoke test ${suffix} — you can ignore this message.`,
    });
    expect(result, `Meta send failed: ${result.error ?? "(no error text)"}`).toEqual({ success: true });
  });
});
