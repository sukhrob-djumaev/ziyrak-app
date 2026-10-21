import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/**
 * P1: the `keyword_alert` automation action used to e-mail an arbitrary rule-supplied address
 * from the legacy global SMTP account shared by every workspace, with no policy check, admission
 * or recorded origin. It now fails closed: nothing is sent until a per-workspace e-mail setting exists.
 */
vi.mock("@/lib/prisma/raw-client", async (importOriginal) => importOriginal());

import { applyAutomationActions } from "@/lib/automations/automation";
import { sendInternalEmailTool } from "@/lib/tools/builtin/send-internal-email";
import { logger } from "@/lib/observability/logger";
import { seedBusiness, cleanupBusiness, type SeededBusiness } from "../helpers/tenant-fixtures";
import type { TenantContext } from "@/lib/tenancy/context";

let business: SeededBusiness;
let ctx: TenantContext;

beforeAll(async () => {
  business = await seedBusiness("keyword-alert");
  ctx = {
    businessId: business.businessId,
    role: null,
    actor: { kind: "system_job", jobId: "test-job", jobType: "process-inbound-message" },
    dataConnection: "shared-default",
  };
});
afterAll(async () => {
  await cleanupBusiness(business.businessId);
});

describe("keyword_alert automation action", () => {
  it("sends no e-mail and says why, even for a well-formed rule", async () => {
    const send = vi.spyOn(sendInternalEmailTool, "execute").mockResolvedValue({
      success: true,
      status: "succeeded",
      message: "sent",
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await applyAutomationActions(ctx, { id: "conversation-1" }, [
      {
        ruleName: "Alert",
        actions: [{ type: "keyword_alert", value: "outsider@example.invalid" }],
      } as never,
    ]);
    expect(send).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((call) => /keyword_alert/.test(String(call[0])))).toBe(true);
    vi.restoreAllMocks();
  });
});
