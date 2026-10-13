/**
 * Child-process worker for the dead-worker test: takes one
 * `process-inbound-message` job, announces it on stdout, and hangs forever so
 * the parent can SIGKILL it mid-job (no drain, heartbeat stops with the process).
 */
import { PgBossJobQueue } from "@/lib/jobs/pgboss-job-queue";
import { PROCESS_INBOUND_MESSAGE_JOB } from "@/lib/jobs/job-types";

const queue = new PgBossJobQueue(process.env.DATABASE_URL!);
queue.registerHandler(PROCESS_INBOUND_MESSAGE_JOB, async () => {
  console.log("TOOK_JOB");
  await new Promise(() => {});
});
void queue.start().then(() => console.log("STARTED"));
