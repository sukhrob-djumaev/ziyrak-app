import type { Readable } from "node:stream";
import type { TenantContext } from "@/lib/tenancy/context";

/**
 * PLAN.md §46.3 (Phase 3) / §27.1 — module-boundary sketch, not a frozen
 * contract. Per review concern 22, Phase 3 fixes only this contract's
 * module location (`storage/`, new — §27.2, there is no existing file
 * persistence to migrate) and that it depends on nothing else in this
 * codebase. No implementation exists yet; that is Phase 7 scope (§46.7,
 * §27.3's `LocalFilesystemStorage`/`S3CompatibleStorage`).
 */
export interface ObjectStorage {
  putObject(
    ctx: TenantContext,
    key: string,
    body: Buffer | Readable,
    opts?: { contentType?: string }
  ): Promise<{ key: string; url?: string }>;
  getObject(ctx: TenantContext, key: string): Promise<Readable>;
  getSignedUrl(ctx: TenantContext, key: string, opts?: { expiresInSeconds?: number }): Promise<string>;
  deleteObject(ctx: TenantContext, key: string): Promise<void>;
}
