import type { ModelClient } from "@repo/ai";
import type { CloudflareClient } from "@repo/cloudflare";
import type { EmailClient } from "@repo/email";

import type { WithDb } from "../db";
import type { AppConfig, QueueMessage, QueuePort } from "../services";
import { classifyReply } from "./classify";
import { pollDomains } from "./domains";
import { deliverMessage, requeueStaleMessages } from "./outbox";
import { processJob } from "./process-job";
import { recordJobFailure, runTick } from "./scheduler";

export interface JobRunnerDeps {
  /** A database client as `duely_system`, for one unit of work. */
  withSystemDb: WithDb;
  email: EmailClient;
  cloudflare: CloudflareClient;
  /** `null` turns the AI features off: every reminder then uses the plain template. */
  model: ModelClient | null;
  config: AppConfig;
  /** Where follow-up messages go. Runtime-specific; the runner never knows which provider is behind it. */
  queue: QueuePort;
  log(event: string, data: Record<string, unknown>): void;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : "error");

/**
 * The provider-agnostic half of background work (D24). A runtime adapter (Cloudflare Queues + Cron,
 * Trigger.dev, anything else) only decides when to call `handle` for each queued message and `tick` on
 * the schedule, and what a thrown error means. Swapping providers never touches this logic.
 */
export function createJobRunner(deps: JobRunnerDeps) {
  const { withSystemDb, queue } = deps;
  const log = (event: string, data: Record<string, unknown>) => deps.log(event, data);

  return {
    /**
     * D13: payloads are ids only. A duplicate or already-handled message is a no-op, so the adapter's
     * only decision is whether to retry. This throws on a transient failure, which the adapter should
     * retry (a transient `send_message` ends up dead-lettered after the provider's retry limit). A failing
     * `process_job` does not throw: the job records the failure and the scheduler retries it with backoff.
     */
    async handle(message: QueueMessage): Promise<void> {
      try {
        if (message.type === "send_message") {
          await withSystemDb((db) => deliverMessage(db, deps, message.messageId));
        } else if (message.type === "classify_reply") {
          await withSystemDb((db) => classifyReply(db, deps, message.messageId));
        } else {
          let produced: Awaited<ReturnType<typeof processJob>>;
          try {
            produced = await withSystemDb((db) => processJob(db, message.jobId, deps));
          } catch (error) {
            log("jobs.process_job_failed", { jobId: message.jobId, error: errorText(error) });
            await withSystemDb((db) => recordJobFailure(db, message.jobId, errorText(error)));
            return;
          }
          // If this throws, the adapter retries; processing the job again finds its message and returns it.
          if (produced.outcome === "queued") {
            await queue.send({ type: "send_message", messageId: produced.messageId });
          }
        }
      } catch (error) {
        log("jobs.message_failed", { type: message.type, error: errorText(error) });
        throw error;
      }
    },

    /** Every minute (SPEC 4.2). Each step is independent: one failing must not starve the next. */
    async tick(): Promise<void> {
      // Re-enqueue anything that committed but never reached the queue (crash between commit and enqueue).
      const requeue = withSystemDb((db) => requeueStaleMessages(db, queue)).then((count) => {
        if (count) log("jobs.requeued_stale_messages", { count });
      });

      // Claim due reminder jobs, reap stuck ones, run the overdue and broken-promise sweeps (SPEC 4.2).
      const tick = withSystemDb((db) => runTick(db, queue)).then((result) => {
        if (result.claimed || result.reaped.dead) log("jobs.tick", { ...result });
      });

      // Custom domains still waiting on DNS or a certificate.
      const domains = withSystemDb((db) => pollDomains(db, deps.cloudflare)).then((result) => {
        if (result.failures) log("jobs.domain_poll_failures", { ...result });
      });

      const results = await Promise.allSettled([requeue, tick, domains]);
      for (const r of results) {
        if (r.status === "rejected") log("jobs.tick_step_failed", { error: String(r.reason) });
      }
    },
  };
}

export type JobRunner = ReturnType<typeof createJobRunner>;
