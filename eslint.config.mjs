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
  // legitimately needs it, to build the scoped client and resolve
  // control-plane placement data), the pre-tenant-context identity/auth
  // layer (which necessarily resolves User/Membership/ApiKey *before* a
  // TenantContext exists to scope with), migration/seed scripts, and tests.
  // §33.4 item 4's deliberate-violation test asserts this rule actually
  // fires.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/lib/tenancy/**",
      "src/lib/prisma/**",
      "src/lib/auth.ts",
      "src/lib/route-auth.ts",
      "src/generated/**",
      // Reads the legacy, pre-Phase-1 Settings singleton for AI config
      // (Settings.aiApiKey) — not a tenant-owned model, and has no defined
      // final destination until Phase 4's AIProviderRegistry exists
      // (§46.1's implementation record). The tenant-owned query in this
      // same file (knowledge entries) already goes through
      // getScopedPrisma(ctx) like everything else.
      "src/app/api/knowledge/test/route.ts",
      // Manages the control-plane User table (create/credential update) as
      // half of the "admin users" (team members) feature; its Membership
      // access already goes through getScopedPrisma(ctx) — see the file's
      // own header comment.
      "src/lib/admin-users/service.ts",
      // First-run setup/login bootstrap: creates the Business/
      // TenantPlacement/User/Membership a TenantContext would itself be
      // resolved from, and resolves login against User before any ctx
      // exists — same pre-tenant-context justification as route-auth.ts.
      "src/app/api/auth/route.ts",
      // Platform-level liveness/readiness probe (raw `SELECT 1`) and a
      // legacy Settings.aiApiKey reachability smoke-test (§4 above) — no
      // tenant data involved.
      "src/app/api/health/route.ts",
      // Closes the raw connection pool on process shutdown
      // (prisma.$disconnect()) — platform lifecycle, not a tenant query.
      "src/lib/shutdown.ts",
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
      // The AI chat/tool-execution pipeline and the channel-adapter
      // integrations it's driven by (WhatsApp Web session, IMAP/SMTP,
      // Twilio SMS/voice, Telegram bot). PLAN.md §46.2's own "Current code
      // involved" list does not name these files, and §46.2's "Explicitly
      // deferred" section places ToolPolicy/ExecutionPrincipal-based AI
      // authorization and full ChannelAdapter contracts at Phase 6/Phase 5
      // respectively — constructing a real `ai_agent`/`channel_credential`
      // TenantContext for inbound-channel-triggered code is that same
      // seam, not yet built. These remain on the Phase 1
      // `getDefaultBusinessId()` compatibility shim until that phase's
      // TenantContext-construction path exists; default-business.ts is
      // therefore not deleted yet either (see its own header comment).
      // This is a deliberate, reported Phase 2 scope boundary, not an
      // oversight — see the Phase 2 completion report.
      "src/lib/ai/engine.ts",
      "src/lib/ai/semantic-search.ts",
      "src/lib/ai/tools.ts",
      "src/lib/customer-resolver.ts",
      "src/lib/channels/email.ts",
      "src/lib/channels/phone.ts",
      "src/lib/channels/sms.ts",
      "src/lib/channels/telegram.ts",
      "src/lib/channels/whatsapp.ts",
      "src/lib/default-business.ts",
      // Reads the legacy Settings.twilioToken (§4 above) for Twilio
      // webhook-signature verification, used only by the deferred
      // channel-adapter webhook routes listed above.
      "src/lib/twilio-verify.ts",
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
]);

export default eslintConfig;
