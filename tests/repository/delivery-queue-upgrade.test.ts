import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PgBoss } from "pg-boss";
vi.mock("@/lib/prisma/raw-client", async (original) => original());
import { prisma } from "@/lib/prisma/raw-client";
import { PgBossJobQueue } from "@/lib/jobs/pgboss-job-queue";
import { SEND_FOLLOWUP_JOB } from "@/lib/jobs/job-types";
describe("delivery queue configuration upgrade (isolated real pg-boss)", () => {
  it("applies the bounded refusal retry policy to an already existing queue", async () => {
    const schema = "delivery_upgrade_" + randomUUID().replaceAll("-", "");
    const prior = new PgBoss({ connectionString: process.env.DATABASE_URL!, schema });
    const queue = new PgBossJobQueue(process.env.DATABASE_URL!, { schema });
    try {
      await prior.start();
      await prior.createQueue(SEND_FOLLOWUP_JOB, {
        retryLimit: 1,
        retryDelay: 0,
        heartbeatSeconds: 10,
      });
      await prior.stop({ graceful: false, close: true });
      await queue.enqueue(SEND_FOLLOWUP_JOB, { businessId: "synthetic-upgrade-business" });
      const [stored] = await prisma.$queryRawUnsafe<
        Array<{ retry_limit: number; retry_delay: number; heartbeat_seconds: number }>
      >(
        `SELECT retry_limit, retry_delay, heartbeat_seconds FROM "${schema}".queue WHERE name='send-followup'`
      );
      expect(stored).toMatchObject({ retry_limit: 5, retry_delay: 10, heartbeat_seconds: 30 });
    } finally {
      await queue.stop();
      await prior.stop({ graceful: false, close: true });
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });
});
