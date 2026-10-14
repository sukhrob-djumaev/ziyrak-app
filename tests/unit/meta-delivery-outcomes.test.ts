import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/lib/tenancy/context";
const f = vi.hoisted(() => ({ owned: vi.fn(), credential: vi.fn() }));
vi.mock("@/lib/tenancy/scoped-prisma", () => ({
  getScopedPrisma: () => ({ channelConnection: { findFirst: f.owned } }),
}));
vi.mock("@/lib/identity/channel-credential-auth", () => ({
  findConnectionByConfigField: vi.fn(),
  buildChannelCredentialContext: vi.fn(),
  resolveChannelCredential: f.credential,
}));
import { metaCloudWhatsAppAdapter } from "@/lib/channels/meta-whatsapp-adapter";
const ctx: TenantContext = {
  businessId: "synthetic-business",
  role: null,
  actor: { kind: "system_job", jobId: "synthetic-job" },
  dataConnection: "shared-default",
};
beforeEach(() => {
  f.owned.mockReset().mockResolvedValue({ id: "synthetic-connection" });
  f.credential.mockReset().mockResolvedValue({
    accessToken: "synthetic-secret-never-used-on-network",
    phoneNumberId: "synthetic-phone",
  });
});
afterEach(() => vi.unstubAllGlobals());
const send = () =>
  metaCloudWhatsAppAdapter.sendMessage(ctx, "synthetic-connection", "synthetic-recipient", {
    text: "Synthetic saved reply",
  });
describe("Meta saved-delivery outcome contract (mocked Graph transport)", () => {
  it("returns acceptance and provider reference without claiming recipient delivery", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "synthetic-provider-id" }] }), {
        status: 200,
      })
    );
    vi.stubGlobal("fetch", fetch);
    expect(await send()).toMatchObject({
      success: true,
      outcome: "accepted",
      providerMessageId: "synthetic-provider-id",
    });
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it.each([
    { status: 400, outcome: "rejected", retryable: false },
    { status: 401, outcome: "rejected", retryable: false },
    { status: 429, outcome: "rejected", retryable: true },
    { status: 500, outcome: "unknown", retryable: false },
    { status: 503, outcome: "unknown", retryable: false },
  ])(
    "classifies HTTP $status conservatively and excludes the provider body",
    async ({ status, outcome, retryable }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("synthetic-private-provider-error", { status }))
      );
      const result = await send();
      expect(result).toMatchObject({ success: false, outcome, retryable });
      expect(JSON.stringify(result)).not.toContain("synthetic-private-provider-error");
    }
  );
  it("treats an aborted/uncertain transport as nonretryable uncertainty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("synthetic-secret-detail", "AbortError"))
    );
    expect(await send()).toMatchObject({ success: false, outcome: "unknown", retryable: false });
  });
  it("does not decrypt or contact Graph when scoped ownership is absent", async () => {
    f.owned.mockResolvedValue(null);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await send()).toMatchObject({ success: false, outcome: "rejected", retryable: false });
    expect(f.credential).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
