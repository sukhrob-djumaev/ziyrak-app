import { vi } from "vitest";

// Set test environment variables
process.env.JWT_SECRET = "test-secret-key-for-testing-only";
// Most test files mock "@/lib/prisma/raw-client" entirely (below), so this
// never opens a real connection for them. tests/repository/*.test.ts
// deliberately unmock it (§34.1/§34.2 — real Postgres required for the
// tenant-scoping extension and composite-FK tests) and need a real,
// reachable database; matches CI's own owly_test database/credentials
// (.github/workflows/ci.yml) but only as a default, so a differently
// configured environment isn't overridden.
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/owly_test?schema=public";
process.env.NODE_ENV = "test";

// Mock Prisma globally
vi.mock("@/lib/prisma/raw-client", () => ({
  prisma: createMockPrismaClient(),
}));

// Phase 2 (§46.2): requireAuth() now resolves a full TenantContext, not just
// {userId, role}. Every test gets a working tenant id + resolved membership
// without needing to mock prisma.business/membership directly — callers
// only care that *some* businessId/role/actor is threaded through.
export const TEST_DEFAULT_BUSINESS_ID = "test-default-business-id";
export const TEST_DEFAULT_USER_ID = "test-admin-id";

vi.mock("@/lib/route-auth", () => ({
  requireAuth: vi.fn().mockResolvedValue({
    businessId: TEST_DEFAULT_BUSINESS_ID,
    role: "admin",
    actor: { kind: "user", userId: TEST_DEFAULT_USER_ID },
    dataConnection: "shared-default",
  }),
  isAuthenticated: vi.fn().mockReturnValue(true),
}));

// Phase 1's default-business stopgap (§46.1) is deleted once every call site
// is converted to ctx.businessId (Phase 2) — this mock is removed in the
// same batch that removes the last real import of it.
vi.mock("@/lib/default-business", () => ({
  getDefaultBusinessId: vi.fn().mockResolvedValue(TEST_DEFAULT_BUSINESS_ID),
}));

// Mock realtime to prevent side effects in tests
vi.mock("@/lib/realtime", () => ({
  emitNewMessage: vi.fn(),
  emitConversationUpdate: vi.fn(),
  emitTyping: vi.fn(),
  publish: vi.fn(),
  subscribe: vi.fn(),
}));

// Mock next/headers
vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  }),
  headers: vi.fn().mockResolvedValue(new Map()),
}));

function createMockPrismaClient() {
  const modelMethods = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    groupBy: vi.fn(),
  };

  const models = [
    "business",
    "membership",
    "user",
    "tenantPlacement",
    "databaseProfile",
    "storageProfile",
    "businessConfig",
    "channelConnection",
    "settings",
    "admin",
    "conversation",
    "message",
    "ticket",
    "knowledgeEntry",
    "category",
    "department",
    "teamMember",
    "tag",
    "conversationTag",
    "callLog",
    "channel",
    "schedule",
    "webhook",
    "webhookDelivery",
    "activityLog",
    "sLARule",
    "cannedResponse",
    "customer",
    "customerNote",
    "automationRule",
    "businessHours",
    "apiKey",
    "internalNote",
    "campaign",
    "flow",
  ];

  const client: Record<string, unknown> = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    $transaction: vi.fn(),
  };

  for (const model of models) {
    client[model] = { ...modelMethods };
    // Each model needs its own vi.fn() instances
    for (const method of Object.keys(modelMethods)) {
      (client[model] as Record<string, unknown>)[method] = vi.fn();
    }
  }

  // getScopedPrisma() (§8.3) calls `.$extends()` on the resolved data-plane
  // client. Route/unit tests here mock model methods directly and mostly
  // assert on response shape or return values, not on the exact injected
  // `where.businessId` — that guarantee is real-Postgres-only territory
  // (§34.2), covered by tests/repository/*.test.ts, which unmock this
  // module the same way auth-bypass-regression.test.ts unmocks route-auth.
  // So `$extends` here is a deliberate no-op passthrough: it must exist (or
  // every migrated route/service crashes calling it), but it must not
  // reimplement tenant-scoping logic, which would just test this mock's
  // behavior instead of the real extension's.
  client.$extends = vi.fn(() => client);

  return client;
}
