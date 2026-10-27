/**
 * Code-owned capability registry (docs/l4.1-catalog-entitlements-design.md section 1). The catalog can only grant keys that
 * appear here, so nothing unimplemented can be sold. Prices, bundles and which keys a bundle contains are catalog data;
 * what a key means and where it is enforced is code.
 */
export type CapabilityKind = "boolean" | "limit";

export interface CapabilityDef {
  key: string;
  label: string;
  kind: CapabilityKind;
  /** How overlapping grants from several purchases combine (no guessed universal summation). */
  combine: "union" | "max" | "sum";
  /** Named call sites that must enforce it before the key may be offered (checked by a test in L4.1b). */
  enforcedBy: readonly string[];
}

export const CAPABILITIES = [
  { key: "channel.webchat", label: "Web Chat channel", kind: "boolean", combine: "union", enforcedBy: ["webchat-connections-service"] },
  { key: "channel.whatsapp_cloud", label: "Meta WhatsApp channel", kind: "boolean", combine: "union", enforcedBy: ["connections-service", "meta-whatsapp-setup"] },
  { key: "automation.rules", label: "Automation rules", kind: "boolean", combine: "union", enforcedBy: ["automation-rules-service", "automation-execution"] },
  { key: "webhooks.outbound", label: "Outbound webhooks", kind: "boolean", combine: "union", enforcedBy: ["webhooks-api", "deliver-webhook-job"] },
  { key: "data.export", label: "Workspace data export", kind: "boolean", combine: "union", enforcedBy: ["export-api"] },
] as const satisfies readonly CapabilityDef[];

export type CapabilityKey = (typeof CAPABILITIES)[number]["key"];

const BY_KEY = new Map<string, CapabilityDef>(CAPABILITIES.map((c) => [c.key, c]));
export const capability = (key: string): CapabilityDef | undefined => BY_KEY.get(key);
