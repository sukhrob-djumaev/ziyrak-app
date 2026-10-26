import crypto from "crypto";
import type { EncryptedSecret, SecretResolver } from "./types";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/**
 * Default SecretResolver implementation: keys come from versioned environment
 * variables (SECRET_KEY_V1, SECRET_KEY_V2, ...), never a hardcoded or single
 * eternal key. The current version is the highest SECRET_KEY_V<n> that is set (or SECRET_KEY_ACTIVE_VERSION);
 * encrypt() always uses it, decrypt() looks up whichever version a given
 * payload was encrypted under, and rotate() re-encrypts under the current one.
 *
 * This is deliberately the simplest implementation that satisfies the
 * SecretResolver boundary (PLAN.md §10.3) — a real KMS/Vault-backed resolver
 * is a future swap behind the same interface, not built here.
 */
export class EnvKeySecretResolver implements SecretResolver {
  private readonly env: NodeJS.ProcessEnv;
  private readonly currentVersion: number;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    this.currentVersion = this.detectCurrentVersion();
  }

  /**
   * F09: versions are discovered from the environment (any SECRET_KEY_V<positive integer> with a value), so a
   * retired V1 or sparse versions work. The active version is the highest configured one unless
   * SECRET_KEY_ACTIVE_VERSION names a configured version (stage a new key before using it, or roll back).
   * Keep an old key configured only while ciphertext under it still exists; `rotate()` re-encrypts onto the active key.
   */
  private detectCurrentVersion(): number {
    const versions = Object.keys(this.env)
      .map((name) => /^SECRET_KEY_V([1-9]\d*)$/.exec(name))
      .filter((m): m is RegExpExecArray => m !== null && Boolean(this.env[m[0]]))
      .map((m) => Number(m[1]));
    if (versions.length === 0) {
      throw new Error(
        "No SECRET_KEY_V<n> environment variable is configured. Set at least one (for example SECRET_KEY_V1) before encrypting or decrypting secrets."
      );
    }
    const requested = this.env.SECRET_KEY_ACTIVE_VERSION;
    if (requested !== undefined && requested !== "") {
      const active = /^[1-9]\d*$/.test(requested) ? Number(requested) : NaN;
      if (!versions.includes(active)) {
        throw new Error("SECRET_KEY_ACTIVE_VERSION must be a positive integer naming a configured SECRET_KEY_V<n>.");
      }
      return active;
    }
    return Math.max(...versions);
  }

  private deriveKey(version: number): Buffer {
    const raw = this.env[`SECRET_KEY_V${version}`];
    if (!raw) {
      throw new Error(
        `No secret key configured for key version ${version} (SECRET_KEY_V${version} is unset). Cannot decrypt a secret encrypted under this version.`
      );
    }
    return crypto.createHash("sha256").update(raw, "utf8").digest();
  }

  async encrypt(plaintext: string): Promise<EncryptedSecret> {
    const key = this.deriveKey(this.currentVersion);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      ciphertext: ciphertext.toString("base64"),
      keyVersion: this.currentVersion,
      algorithm: ALGORITHM,
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
    };
  }

  async decrypt(secret: EncryptedSecret): Promise<string> {
    if (secret.algorithm !== ALGORITHM) {
      throw new Error(`Unsupported secret algorithm: ${secret.algorithm}`);
    }
    const key = this.deriveKey(secret.keyVersion);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(secret.iv, "base64"));
    decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  }

  async rotate(secret: EncryptedSecret): Promise<EncryptedSecret> {
    if (secret.keyVersion === this.currentVersion) return secret;
    const plaintext = await this.decrypt(secret);
    return this.encrypt(plaintext);
  }
}

let defaultResolver: EnvKeySecretResolver | null = null;

/** Lazily-constructed default resolver, shared across the process. */
export function getSecretResolver(): SecretResolver {
  if (!defaultResolver) defaultResolver = new EnvKeySecretResolver();
  return defaultResolver;
}
