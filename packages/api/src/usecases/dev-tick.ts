import type { ModelClient } from "@repo/ai";
import type { Db } from "@repo/db";
import { sql } from "drizzle-orm";

import type { QueueMessage, QueuePort } from "../services";
import { processJob } from "./process-job";
import { runTick } from "./scheduler";

/**
 * Local development and E2E only (the dev route is inert in live mode). With no jobs worker running, this
 * does what one cycle of it would: a scheduler tick, then each `process_job`, then queues any message that
 * needs no approval. `makeDue` stands in for days passing by pulling every waiting reminder forward.
 */
export async function runDevTick(
  systemDb: Db,
  queue: QueuePort,
  { makeDue = false, model = null }: { makeDue?: boolean; model?: ModelClient | null } = {},
) {
  if (makeDue) {
    await systemDb.execute(
      sql`update reminder_jobs set next_run_at = now() - interval '1 minute' where status = 'scheduled'`,
    );
  }
  const jobs: QueueMessage[] = [];
  const tick = await runTick(systemDb, { send: async (m) => void jobs.push(m) });
  let drafted = 0;
  for (const message of jobs) {
    if (message.type !== "process_job") continue;
    const result = await processJob(systemDb, message.jobId, { model });
    if (result.outcome === "drafted") drafted++;
    if (result.outcome === "queued") {
      await queue.send({ type: "send_message", messageId: result.messageId });
    }
  }
  return { ...tick, drafted };
}
