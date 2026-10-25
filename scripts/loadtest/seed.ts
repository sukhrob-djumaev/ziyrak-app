/**
 * PLAN.md §46.8 — seeds the load test's throwaway database: one business
 * built through the production provisioning path, an AI provider pointed at
 * the local stand-in, and one Web Chat widget connection. Prints the ids the
 * harness needs as JSON on stdout. Runs with the same SECRET_KEY_V1 as the
 * replicas (scripts/loadtest/run.sh sets both).
 */
import { provisionBusiness } from "@/lib/platform/provisioning";
import { prisma } from "@/lib/prisma/raw-client";
import { encryptAIProviderCredential } from "@/lib/ai/config";
import { createWebChatConnection } from "@/lib/channels/webchat-connections-service";
import type { TenantContext } from "@/lib/tenancy/context";
import { WORKSPACE_SCOPE } from "@/lib/tenancy/resource-scope";

export const LOADTEST_ORIGIN = "http://localhost:4020";

async function main() {
  const suffix = Math.random().toString(36).slice(2, 8);
  const provisioned = await provisionBusiness({
    businessName: `Load Test ${suffix}`,
    ownerUsername: `loadtest-${suffix}`,
    ownerPassword: "not-a-real-login-password",
    ownerName: "Load Test Owner",
  });

  const aiCredentialRef = await encryptAIProviderCredential("openai", "sk-loadtest-standin");
  await prisma.businessConfig.upsert({
    where: { businessId: provisioned.businessId },
    update: { aiProvider: "openai", aiModel: "gpt-4o-mini", aiCredentialRef },
    create: { businessId: provisioned.businessId, aiProvider: "openai", aiModel: "gpt-4o-mini", aiCredentialRef },
  });

  const ctx: TenantContext = {
    businessId: provisioned.businessId,
    role: "owner",
    actor: { kind: "user", userId: provisioned.userId },
    dataConnection: "shared-default",
    resourceScope: WORKSPACE_SCOPE,
  };
  const connection = await createWebChatConnection(ctx, { name: "Load test widget", allowedOrigins: [LOADTEST_ORIGIN] });

  console.log(JSON.stringify({ businessId: provisioned.businessId, connectionId: connection.connectionId, token: connection.token, origin: LOADTEST_ORIGIN }));
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
