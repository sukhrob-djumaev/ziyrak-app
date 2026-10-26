import { describe, it, expect } from "vitest";
import { EnvKeySecretResolver } from "@/lib/secrets/env-key-resolver";

/** L1.3 / F09: key retirement and sparse versions. Old keys stay only while old ciphertext needs them. */
const make = (env: Record<string, string>) => new EnvKeySecretResolver(env as unknown as NodeJS.ProcessEnv);

describe("secret key rotation and retirement (F09)", () => {
  it("works with only a later version configured (V1 retired)", async () => {
    const r = make({ SECRET_KEY_V2: "key-two" });
    const enc = await r.encrypt("value");
    expect(enc.keyVersion).toBe(2);
    expect(await r.decrypt(enc)).toBe("value");
  });

  it("selects the highest configured version even when versions are sparse", async () => {
    const r = make({ SECRET_KEY_V1: "one", SECRET_KEY_V3: "three" });
    expect((await r.encrypt("v")).keyVersion).toBe(3);
  });

  it("honours an explicit active version, so a new key can be staged before it is used", async () => {
    const env = { SECRET_KEY_V1: "one", SECRET_KEY_V2: "two", SECRET_KEY_ACTIVE_VERSION: "1" };
    expect((await make(env).encrypt("v")).keyVersion).toBe(1);
  });

  it("refuses an active version that is not configured or not a positive integer", () => {
    expect(() => make({ SECRET_KEY_V1: "one", SECRET_KEY_ACTIVE_VERSION: "2" })).toThrow(/ACTIVE_VERSION/);
    expect(() => make({ SECRET_KEY_V1: "one", SECRET_KEY_ACTIVE_VERSION: "abc" })).toThrow(/ACTIVE_VERSION/);
    expect(() => make({ SECRET_KEY_V1: "one", SECRET_KEY_ACTIVE_VERSION: "0" })).toThrow(/ACTIVE_VERSION/);
  });

  it("ignores malformed names and empty values when discovering versions", async () => {
    const r = make({ SECRET_KEY_V1: "one", SECRET_KEY_V2: "", SECRET_KEY_V02: "x", SECRET_KEY_VX: "x", SECRET_KEY_V: "x" });
    expect((await r.encrypt("v")).keyVersion).toBe(1);
  });

  it("rotates old ciphertext to the active key while the old key is still configured, then the old key can be retired", async () => {
    const old = await make({ SECRET_KEY_V1: "one" }).encrypt("payload");
    const during = make({ SECRET_KEY_V1: "one", SECRET_KEY_V2: "two" });
    const moved = await during.rotate(old);
    expect(moved.keyVersion).toBe(2);
    const after = make({ SECRET_KEY_V2: "two" }); // V1 retired
    expect(await after.decrypt(moved)).toBe("payload");
  });

  it("gives a clear error when ciphertext needs a retired key", async () => {
    const old = await make({ SECRET_KEY_V1: "one" }).encrypt("payload");
    await expect(make({ SECRET_KEY_V2: "two" }).decrypt(old)).rejects.toThrow(/key version 1/);
  });

  it("still throws when no key is configured at all", () => {
    expect(() => make({})).toThrow(/SECRET_KEY_V/);
  });
});
