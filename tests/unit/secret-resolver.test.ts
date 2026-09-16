import { describe, it, expect } from "vitest";
import { EnvKeySecretResolver } from "@/lib/secrets/env-key-resolver";

function resolverWithEnv(env: Record<string, string>) {
  return new EnvKeySecretResolver(env as unknown as NodeJS.ProcessEnv);
}

describe("EnvKeySecretResolver", () => {
  it("round-trips a plaintext secret through encrypt/decrypt", async () => {
    const resolver = resolverWithEnv({ SECRET_KEY_V1: "test-key-v1-do-not-use" });

    const encrypted = await resolver.encrypt("super-secret-value");
    expect(encrypted.algorithm).toBe("aes-256-gcm");
    expect(encrypted.keyVersion).toBe(1);
    expect(encrypted.ciphertext).not.toContain("super-secret-value");

    const decrypted = await resolver.decrypt(encrypted);
    expect(decrypted).toBe("super-secret-value");
  });

  it("produces different ciphertext for the same plaintext each time (random IV)", async () => {
    const resolver = resolverWithEnv({ SECRET_KEY_V1: "test-key-v1" });

    const a = await resolver.encrypt("same-value");
    const b = await resolver.encrypt("same-value");

    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  it("always encrypts under the current (highest configured) key version", async () => {
    const resolver = resolverWithEnv({
      SECRET_KEY_V1: "key-one",
      SECRET_KEY_V2: "key-two",
    });

    const encrypted = await resolver.encrypt("value");
    expect(encrypted.keyVersion).toBe(2);
  });

  it("decrypts a payload encrypted under an older key version after rotation", async () => {
    const v1Resolver = resolverWithEnv({ SECRET_KEY_V1: "key-one" });
    const encryptedUnderV1 = await v1Resolver.encrypt("value");

    const v2Resolver = resolverWithEnv({
      SECRET_KEY_V1: "key-one",
      SECRET_KEY_V2: "key-two",
    });

    // Still decryptable under the old version without rotating.
    expect(await v2Resolver.decrypt(encryptedUnderV1)).toBe("value");

    const rotated = await v2Resolver.rotate(encryptedUnderV1);
    expect(rotated.keyVersion).toBe(2);
    expect(await v2Resolver.decrypt(rotated)).toBe("value");
  });

  it("rotate() is a no-op when already on the current key version", async () => {
    const resolver = resolverWithEnv({ SECRET_KEY_V1: "key-one" });
    const encrypted = await resolver.encrypt("value");

    const rotated = await resolver.rotate(encrypted);
    expect(rotated).toEqual(encrypted);
  });

  it("fails closed when decrypting under a key version that no longer exists", async () => {
    const resolver = resolverWithEnv({ SECRET_KEY_V1: "key-one" });
    const encryptedUnderMissingVersion = { ...(await resolver.encrypt("value")), keyVersion: 99 };

    await expect(resolver.decrypt(encryptedUnderMissingVersion)).rejects.toThrow(/key version 99/);
  });

  it("fails closed when the ciphertext or auth tag has been tampered with", async () => {
    const resolver = resolverWithEnv({ SECRET_KEY_V1: "key-one" });
    const encrypted = await resolver.encrypt("value");

    const tampered = { ...encrypted, ciphertext: Buffer.from("tampered-data").toString("base64") };
    await expect(resolver.decrypt(tampered)).rejects.toThrow();
  });

  it("throws at construction time when no SECRET_KEY_V<n> is configured", () => {
    expect(() => resolverWithEnv({})).toThrow(/SECRET_KEY_V/);
  });
});
