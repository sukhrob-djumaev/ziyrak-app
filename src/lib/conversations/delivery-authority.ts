import type { TenantContext } from "@/lib/tenancy/context";
import type { AdmissionSession } from "@/lib/tenancy/scoped-prisma";
/** Application-composed fresh authority, never a queue adapter or ambient role. */
export interface FollowupSubmissionBinding {
  deliveryId: string;
  actionId: string;
  conversationId: string;
  connectionId: string;
  channel: string;
  recipient: string;
  response: string;
}
/** Fresh facts for one sending admission. `notAfter` is the earliest expiry among the facts
 * used (for example an API key); the admission judges it at its final decision timestamp.
 */
export interface AdmittedFollowup {
  context: TenantContext;
  notAfter?: Date;
}
export type AuthorizeFollowupSubmission = (
  worker: TenantContext,
  binding: Readonly<FollowupSubmissionBinding>,
  session: AdmissionSession
) => Promise<AdmittedFollowup>;

import { z } from "zod";
const id = z.string().min(1).max(128);
const origin = z.union([
  z.object({ kind: z.literal("membership"), userId: id, membershipId: id }).strict(),
  z
    .object({
      kind: z.literal("api_key"),
      apiKeyId: id,
      scopeOrigin: z.literal("issuer"),
      issuerUserId: id,
      issuerMembershipId: id,
    })
    .strict(),
  z
    .object({
      kind: z.literal("api_key"),
      apiKeyId: id,
      scopeOrigin: z.literal("legacy_workspace"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("provider_inbound"),
      receiptId: id,
      deliveryOperationId: id,
      conversationId: id,
      connectionId: id,
    })
    .strict(),
]);
const delegated = z
  .object({
    kind: z.literal("delegated_job"),
    actorUserId: id.optional(),
    allowedOperations: z.tuple([z.literal("messages:create")]),
    origin,
  })
  .strict();
/** Shape/binding validation of the public composition seam; the authorizer owns freshness. */
export function validFollowupProvenance(
  input: unknown,
  binding: Readonly<FollowupSubmissionBinding>
) {
  const parsed = delegated.safeParse(input);
  if (!parsed.success) return false;
  const auth = parsed.data;
  if (auth.origin.kind === "membership") return auth.actorUserId === auth.origin.userId;
  if (auth.actorUserId !== undefined) return false;
  return (
    auth.origin.kind !== "provider_inbound" ||
    (auth.origin.conversationId === binding.conversationId &&
      auth.origin.connectionId === binding.connectionId &&
      auth.origin.deliveryOperationId !== binding.deliveryId)
  );
}
