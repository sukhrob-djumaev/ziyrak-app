import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/generated/**",
  ]),
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
    },
  },
  // PLAN.md §8.3/§16.4/§36 — the raw Prisma client bypasses tenant scoping
  // entirely, so it is unimportable from application/domain code outside a
  // small, explicit allowlist: the tenancy module itself (which is what
  // legitimately needs it, to build the scoped client), the platform/
  // control-plane module (§6 — Business/User/Membership/TenantPlacement
  // resolution, which necessarily runs before a TenantContext exists to
  // scope with), the pre-tenant-context identity/auth layer (same reason),
  // migration/seed scripts, and tests. §33.4 item 4's deliberate-violation
  // test asserts this rule actually fires. Paths below were updated for
  // §46.3's module reorganization (§6) — the rationale on each unchanged
  // from its pre-move comment.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/lib/tenancy/**",
      "src/lib/platform/**",
      "src/lib/prisma/**",
      "src/lib/identity/auth.ts",
      "src/lib/identity/route-auth.ts",
      "src/generated/**",
      // Reads the legacy, pre-Phase-1 Settings singleton for AI config
      // (Settings.aiApiKey) — not a tenant-owned model, and has no defined
      // final destination until Phase 4's AIProviderRegistry exists
      // (§46.1's implementation record). The tenant-owned query in this
      // same file (knowledge entries) already goes through
      // getScopedPrisma(ctx) like everything else.
      "src/app/api/knowledge/test/route.ts",
      // First-run setup/login bootstrap: creates the Business/
      // TenantPlacement/User/Membership a TenantContext would itself be
      // resolved from, and resolves login against User before any ctx
      // exists — same pre-tenant-context justification as route-auth.ts.
      "src/app/api/auth/route.ts",
      // Platform-level liveness/readiness probe (raw `SELECT 1`) and a
      // legacy Settings.aiApiKey reachability smoke-test (§4 above) — no
      // tenant data involved.
      "src/app/api/health/route.ts",
      // Legacy Settings singleton (businessName/tone/channel-credential
      // fields) — superseded by BusinessConfig + ChannelConnection
      // (§10.2/§7.7), but Settings.aiApiKey has no defined final
      // destination until Phase 4's AIProviderRegistry exists (§46.1's
      // implementation record). Migrating this route's full contract to
      // BusinessConfig/ChannelConnection is deferred there rather than
      // done as a partial, contract-breaking rewrite now; every OTHER
      // route that used to read/write Settings/the legacy Channel model
      // (channels, business-hours, etc.) has already been cut over to its
      // Phase-1-built tenant-scoped replacement in this phase.
      "src/app/api/settings/route.ts",
      // Post-audit status (Phase 2 runtime-isolation audit): these files
      // are now ctx-aware everywhere it's structurally possible
      // (getScopedPrisma(ctx) for every tenant-owned model; customer-
      // resolver.ts needed no raw-client allowlisting at all after the
      // audit and was removed from this list entirely). The raw client
      // remains here ONLY for the legacy global Settings singleton
      // (provider/model/API key, SMTP/IMAP/Twilio/Telegram credentials) —
      // genuinely global infra config with no per-business destination
      // until Phase 4's AIProviderRegistry/Phase 5's ChannelAdapter exist.
      // Every code path that reaches these files from an authenticated
      // route now fails closed via assertDefaultBusinessOnly() rather than
      // silently resolving to the Default Business (see
      // default-business.ts's own header comment and the Phase 2
      // completion report's runtime-isolation audit). The channel-adapter
      // files' *inbound* (webhook-triggered) paths have no authenticated
      // caller to fail closed for at all — they explicitly construct a
      // Default-Business-only TenantContext via
      // getDefaultBusinessContext(), since no per-connection inbound
      // tenant resolution exists yet (Phase 5).
      "src/lib/ai/engine.ts",
      "src/lib/knowledge/semantic-search.ts",
      "src/lib/tools/tools.ts",
      "src/lib/channels/email.ts",
      "src/lib/channels/phone.ts",
      "src/lib/channels/sms.ts",
      "src/lib/channels/telegram.ts",
      "src/lib/channels/whatsapp.ts",
      // Reads the legacy Settings.twilioToken (§4 above) for Twilio
      // webhook-signature verification, used only by the deferred
      // channel-adapter webhook routes listed above.
      "src/lib/channels/twilio-verify.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/prisma/raw-client",
              message:
                "The raw Prisma client bypasses tenant scoping (PLAN.md §8.3). Use getScopedPrisma(ctx) from '@/lib/tenancy/scoped-prisma' instead. If this file is genuinely platform/control-plane code that must run before a TenantContext exists, add it to the narrow allowlist in eslint.config.mjs with a comment explaining why.",
            },
          ],
        },
      ],
      // no-restricted-imports (above) only covers static `import`
      // declarations — a dynamic `await import("@/lib/prisma/raw-client")`
      // slips through it entirely (confirmed empirically). This closes
      // that gap so the two forms are equally restricted.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value='@/lib/prisma/raw-client']",
          message:
            "The raw Prisma client bypasses tenant scoping (PLAN.md §8.3), including via dynamic import(). Use getScopedPrisma(ctx) from '@/lib/tenancy/scoped-prisma' instead, or add this file to the allowlist in eslint.config.mjs with a comment explaining why.",
        },
      ],
    },
  },
  // PLAN.md §46.3/§5.7 — module dependency-direction boundary: a
  // ChannelAdapter implementation must not import from `ai/` (it emits
  // normalized events and lets the application layer decide what to do
  // with them). This is enforced going forward; the five existing channel
  // files still call `ai/engine.ts`'s `chat()`/`createNewConversation()`
  // directly, which is real, pre-existing, and intentional until Phase 5
  // gives every channel a real `ChannelAdapter` contract + the `events/`
  // envelope to publish through instead (§19, §46.5) — rewriting that
  // coupling now would be exactly the "build Phase 5 early" this phase's
  // own principle forbids. Any *new* file under `channels/` is held to the
  // target rule with no exception. `tests/security/module-boundary-lint.
  // test.ts` is this rule's own deliberate-violation test, mirroring
  // `raw-prisma-lint.test.ts`'s pattern.
  {
    files: ["src/lib/channels/**/*.{ts,tsx}"],
    ignores: [
      "src/lib/channels/email.ts",
      "src/lib/channels/phone.ts",
      "src/lib/channels/sms.ts",
      "src/lib/channels/telegram.ts",
      "src/lib/channels/whatsapp.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/ai", "@/lib/ai/*"],
              message:
                "A ChannelAdapter implementation must not import from ai/ (PLAN.md §5.7/§19.1) — it should emit a normalized event and let the application layer decide what to do with it.",
            },
          ],
        },
      ],
    },
  },
  // PLAN.md §46.3/§5.7 — the other half of the same boundary: `ai/` may
  // depend on the `AIProvider`/`EmbeddingProvider` *contracts* it owns
  // (§21.1/§21.5, sketched at `src/lib/ai/providers/types.ts`), never on a
  // concrete channel/messaging SDK directly. `ai/tools.ts` (the one file
  // that used to import `nodemailer` here) moved to `tools/` in this same
  // phase, so this rule has no exceptions to carry forward.
  {
    files: ["src/lib/ai/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "whatsapp-web.js",
            "twilio",
            "nodemailer",
            "imap",
            "mailparser",
          ].map((name) => ({
            name,
            message:
              "ai/ must not import a concrete channel/messaging SDK directly (PLAN.md §5.7) — that belongs behind a channels/ or tools/ boundary.",
          })),
        },
      ],
    },
  },
]);

export default eslintConfig;
