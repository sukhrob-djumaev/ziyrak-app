// Test-owned worker for an actual pg-boss crash/restart rehearsal.
import "@/lib/tools/builtin";
import { PgBossJobQueue } from "@/lib/jobs/pgboss-job-queue";
import { handleSendFollowup } from "@/lib/jobs/handlers/send-followup";
import { SEND_FOLLOWUP_JOB } from "@/lib/jobs/job-types";
import { registerChannelAdapter } from "@/lib/channels/registry";
import { prisma } from "@/lib/prisma/raw-client";
async function main() {
  const db = process.env.DATABASE_URL!;
  if (db !== process.env.DIRECT_DATABASE_URL || new URL(db).pathname === "/ziyrak")
    throw new Error("Isolated paired test database required");
  const target = new URL(process.env.DELIVERY_RESTART_PROVIDER!);
  if (target.hostname !== "127.0.0.1")
    throw new Error("Only a test-owned loopback provider is allowed");
  registerChannelAdapter("restart-test", {
    type: "restart-test",
    capabilities: {
      supportsMedia: false,
      supportsTemplates: false,
      supportsTypingIndicator: false,
      supportsDeliveryReceipts: false,
      supportsMultipleConnections: true,
    },
    validateInbound: async () => ({ kind: "rejected", reason: "test" }),
    getStatus: async () => ({ connected: true }),
    sendMessage: async (_ctx, _id, _to, content) => {
      await fetch(target, { method: "POST", body: JSON.stringify({ text: content.text }) });
      return { success: true, providerMessageId: "synthetic-restart-provider" };
    },
  });
  const queue = new PgBossJobQueue(db, { schema: process.env.DELIVERY_RESTART_SCHEMA! });
  queue.registerHandler(SEND_FOLLOWUP_JOB, handleSendFollowup);
  await queue.start();
  process.send?.({ ready: true });
  process.once("SIGTERM", () => {
    void queue
      .stop()
      .then(() => prisma.$disconnect())
      .then(() => process.exit(0));
  });
}
void main().catch(() => {
  console.error("Test restart worker could not start");
  process.exit(1);
});
