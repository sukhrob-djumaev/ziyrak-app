import { createHash, timingSafeEqual } from "node:crypto";

/**
 * L1.3: true when `proof` is the platform owner's bootstrap or recovery secret. Used only so the very first
 * super admin (who has no other super admin to issue a setup code) can enroll a second factor.
 */
export function ownerProofValid(proof: unknown): boolean {
  if (typeof proof !== "string" || !proof) return false;
  const actual = createHash("sha256").update(proof).digest();
  return (["BOOTSTRAP", "RECOVERY"] as const).some((kind) => {
    const expected = process.env[`PLATFORM_${kind}_PROOF_SHA256`];
    return Boolean(expected && /^[a-fA-F0-9]{64}$/.test(expected) && timingSafeEqual(actual, Buffer.from(expected, "hex")));
  });
}
