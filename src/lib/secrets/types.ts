/**
 * The SecretResolver boundary (PLAN.md §10.3). This is the only interface any
 * application code should depend on to encrypt/decrypt a channel credential or
 * infrastructure connection secret — never a concrete KMS/env implementation
 * directly, so the env-backed default can later be swapped for AWS/GCP KMS,
 * Azure Key Vault, or HashiCorp Vault without touching a call site.
 */
export interface EncryptedSecret {
  ciphertext: string;
  keyVersion: number;
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
}

export interface SecretResolver {
  /** Always encrypts under the current key version. */
  encrypt(plaintext: string): Promise<EncryptedSecret>;
  /** Looks up the key for `secret.keyVersion` and decrypts. */
  decrypt(secret: EncryptedSecret): Promise<string>;
  /** Re-encrypts under the current key version; no-op if already current. */
  rotate(secret: EncryptedSecret): Promise<EncryptedSecret>;
}
