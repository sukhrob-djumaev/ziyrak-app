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
      // PLAN.md §6/§14.3/§46.5 — resolves which business an identity-less
      // inbound channel webhook belongs to (ChannelConnection lookup by
      // provider identifier), the same pre-ctx reason route-auth.ts is here.
      "src/lib/identity/channel-credential-auth.ts",
      "src/generated/**",
      // PLAN.md §46.4 — the one narrow, documented read of the legacy
      // Settings singleton left after this phase: resolveAIConfig()/
      // resolveEmbeddingConfig()'s Default-Business-only, "hasn't touched
      // its own BusinessConfig yet" backward-compat fallback (this module's
      // own header comment explains the precedence). Every other AI-config
      // read in this file goes through getScopedPrisma(ctx)'s BusinessConfig
      // lookup like everything else.
      "src/lib/ai/config.ts",
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
      // Post-audit status (Phase 2 runtime-isolation audit), narrowed
      // further by Phase 5: every one of this list's *channel-adapter*
      // entries (email/phone/sms/telegram/whatsapp) is gone as of §46.5 —
      // each now resolves a real per-`ChannelConnection` `TenantContext`
      // via `identity/channel-credential-auth.ts` instead of reading the
      // legacy global `Settings` singleton or falling back to the Default
      // Business (`getDefaultBusinessContext()`, itself now called only by
      // `WhatsAppWebAdapter`'s permanently-gated dev/demo path, guarded by
      // `assertDefaultBusinessOnly()`, not by silent fallback). The one
      // remaining entry below reads `Settings.welcomeMessage`-equivalent
      // global config with no per-business destination of its own yet.
      // PLAN.md §46.6 — `tools/tools.ts`'s switch statement (and this SMTP
      // read within it) was mechanically extracted into
      // `tools/builtin/send-internal-email.ts` unchanged; the allowlist
      // entry moves with it.
      "src/lib/tools/builtin/send-internal-email.ts",
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
  // PLAN.md §46.3/§46.5/§5.7 — module dependency-direction boundary: a
  // ChannelAdapter implementation must not import from `ai/` (it emits
  // normalized events and lets the application layer decide what to do
  // with them). Phase 3 introduced this rule with a temporary allowlist for
  // the five pre-existing channel files, which still called `ai/engine.ts`'s
  // `chat()`/`createNewConversation()` directly pending the `ChannelAdapter`
  // contract and `events/` envelope this phase introduces. That allowlist
  // is gone: every channel (the five migrated adapters plus the new
  // `WebChatAdapter`) now emits a normalized `ZiyrakEvent` and funnels
  // through `processInboundMessage` (`conversations/inbound.ts`) instead of
  // calling `ai/` directly — closing the architectural violation Phase 3
  // deferred, per §46.5's own acceptance criteria. No exceptions remain.
  // `tests/security/module-boundary-lint.test.ts` is this rule's own
  // deliberate-violation test, mirroring `raw-prisma-lint.test.ts`'s
  // pattern, and now also proves a real, previously-allowlisted file
  // (`whatsapp.ts`) is held to the same rule as everything else.
  {
    files: ["src/lib/channels/**/*.{ts,tsx}"],
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
