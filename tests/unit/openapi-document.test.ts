import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/openapi.json/route";

/** L3.2 / D11 — the served API description must not carry upstream identity or claim unverified channels. */
describe("served OpenAPI document", () => {
  it("names no upstream project and offers no unverified channel as a filter value", async () => {
    const text = JSON.stringify(await (await GET()).json());
    expect(text).not.toMatch(/Hesper|github\.com\/Hesper-Labs/i);
    const spec = JSON.parse(text);
    expect(spec.info.contact).toBeUndefined();
    expect(spec.info.license).toBeUndefined();
    const channel = spec.paths["/conversations"].get.parameters.find((p: { name: string }) => p.name === "channel");
    expect(channel.schema.enum).toEqual(["whatsapp_cloud", "webchat"]);
    expect(spec.info.description).toMatch(/not verified/i);
  });
  it("describes the authentication the API really accepts", async () => {
    const spec = await (await GET()).json();
    expect(spec.components.securitySchemes.cookieAuth.name).toBe("ziyrak-token");
    expect(spec.components.securitySchemes.apiKeyAuth).toMatchObject({ in: "header", name: "x-api-key" });
  });
});
