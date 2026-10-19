import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { seedBusiness, cleanupBusiness } from "../helpers/tenant-fixtures";
import { authorizeSeededFollowup } from "../helpers/followup-fixtures";
import { PgBossJobQueue } from "@/lib/jobs/pgboss-job-queue";
import { SEND_FOLLOWUP_JOB } from "@/lib/jobs/job-types";
async function waitFor(predicate: () => Promise<boolean>, timeout = 150000) {
  const until = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > until)
      throw new Error("Timed out waiting for actual pg-boss restart recovery");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
describe("actual worker crash and restart", () => {
  it("recovers a lost sending claim into human review without a second external submission", async () => {
    const business = await seedBusiness("delivery-restart");
    const schema = "delivery_restart_" + randomUUID().replaceAll("-", "");
    const queue = new PgBossJobQueue(process.env.DATABASE_URL!, { schema });
    let submissions = 0;
    const server = createServer((req, res) => {
      submissions++;
      req.resume();
      if (submissions > 1) res.end("unexpected second submission");
      // First submission stays unresolved until the worker is killed.
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test provider listener");
    let first: ChildProcess | undefined, second: ChildProcess | undefined;
    const env = {
      ...process.env,
      NODE_ENV: "test",
      DELIVERY_RESTART_SCHEMA: schema,
      DELIVERY_RESTART_PROVIDER: "http://127.0.0.1:" + address.port,
    };
    const start = () =>
      spawn(process.execPath, ["--import", "tsx", "tests/helpers/delivery-restart-worker.ts"], {
        cwd: process.cwd(),
        env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
    try {
      const conn = await prisma.channelConnection.create({
        data: {
          businessId: business.businessId,
          type: "restart-test",
          name: "Synthetic restart provider",
          isActive: true,
        },
      });
      const conv = await prisma.conversation.create({
        data: {
          businessId: business.businessId,
          channel: "restart-test",
          customerContact: "synthetic-recipient",
          metadata: { channelConnectionId: conn.id },
        },
      });
      const key = randomUUID(),
        message = "Saved crash-recovery reply";
      const action = await prisma.actionExecution.create({
        data: {
          businessId: business.businessId,
          conversationId: conv.id,
          tool: "schedule_followup",
          status: "scheduled",
          input: { message },
          requestedBy: business.ownerUserId,
          idempotencyKey: key,
        },
      });
      await authorizeSeededFollowup(business.ctx, action.id, conv.id, conn.id);
      await queue.enqueue(SEND_FOLLOWUP_JOB, {
        businessId: business.businessId,
        conversationId: conv.id,
        channel: "restart-test",
        connectionId: conn.id,
        to: conv.customerContact,
        message,
        idempotencyKey: key,
      });
      first = start();
      await waitFor(async () => submissions === 1, 15000);
      const claimed = await prisma.deliveryOperation.findFirstOrThrow({
        where: { actionId: action.id },
      });
      expect(claimed.status).toBe("sending");
      expect(claimed.response).toBe(message);
      const exited = once(first, "exit");
      first.kill("SIGKILL");
      await exited;
      second = start();
      // No shortened lease or queue-state injection: wait for real heartbeat,
      // claim expiry, pg-boss failure/retry and the replacement process.
      await waitFor(
        async () =>
          (await prisma.actionExecution.findUniqueOrThrow({ where: { id: action.id } })).status ===
          "needs_review"
      );
      expect(submissions).toBe(1);
      const recovered = await prisma.deliveryOperation.findUniqueOrThrow({
        where: { id: claimed.id },
      });
      expect(recovered.status).toBe("unknown");
      expect(recovered.attempts).toBe(1);
      expect(await prisma.message.count({ where: { conversationId: conv.id } })).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(submissions).toBe(1);
    } finally {
      for (const child of [first, second]) {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGTERM");
          await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await exited;
          }
        }
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await queue.stop();
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await cleanupBusiness(business.businessId);
    }
  }, 180000);
});
