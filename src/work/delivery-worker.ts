import type { DbPort } from "../ports.js";
import type { DeliveryRecord } from "../types.js";

export interface DeliveryWorkerOptions {
  consumer: string;
  maxAttempts?: number;
  baseBackoffMs?: number;
  handler: (delivery: DeliveryRecord) => Promise<void>;
}

export interface DeliveryDrainResult {
  processed: number;
  succeeded: number;
  retried: number;
  dead: number;
}

/**
 * Outbox `deliveries` backoff retry worker (v0.5):
 * - Enqueues side effects keyed by `(consumer, seq)` idempotency key
 * - Retries transient provider errors with exponential backoff (`baseBackoffMs * 2^(attempts-1)`)
 * - Transitions exhausted items (`attempts >= maxAttempts`) to `dead` so poison rows never stall the queue
 * - Advances `consumer_cursors` upon successful delivery
 */
export class DeliveryRetryWorker {
  private readonly consumer: string;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly handler: (delivery: DeliveryRecord) => Promise<void>;

  constructor(
    private readonly db: DbPort,
    options: DeliveryWorkerOptions,
  ) {
    this.consumer = options.consumer;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.handler = options.handler;
  }

  enqueue(seq: number, now = new Date()): boolean {
    const iso = now.toISOString();
    return this.db.enqueueDelivery({
      consumer: this.consumer,
      seq,
      dueAt: iso,
      createdAt: iso,
    });
  }

  async drainDue(params?: {
    limit?: number;
    now?: Date;
  }): Promise<DeliveryDrainResult> {
    const now = params?.now ?? new Date();
    const nowIso = now.toISOString();
    const due = this.db.listDueDeliveries({
      consumer: this.consumer,
      nowIso,
      limit: params?.limit ?? 25,
    });

    let processed = 0;
    let succeeded = 0;
    let retried = 0;
    let dead = 0;

    for (const item of due) {
      processed += 1;
      const attemptNum = item.attempts + 1;
      this.db.updateDeliveryState({
        consumer: item.consumer,
        seq: item.seq,
        state: "processing",
        attempts: attemptNum,
        dueAt: item.dueAt,
        lastError: item.lastError,
        updatedAt: nowIso,
      });

      try {
        await this.handler({ ...item, attempts: attemptNum });
        const doneIso = new Date().toISOString();
        this.db.updateDeliveryState({
          consumer: item.consumer,
          seq: item.seq,
          state: "succeeded",
          attempts: attemptNum,
          dueAt: doneIso,
          lastError: null,
          updatedAt: doneIso,
        });
        const curCursor = this.db.getConsumerCursor(this.consumer);
        const gen = this.db.getChangeLogGeneration();
        if (!curCursor || curCursor.generation !== gen || item.seq > curCursor.seq) {
          this.db.upsertConsumerCursor({
            consumer: this.consumer,
            generation: gen,
            seq: item.seq,
            updatedAt: doneIso,
          });
        }
        succeeded += 1;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const failNow = params?.now ?? new Date();
        const failIso = failNow.toISOString();
        if (attemptNum >= this.maxAttempts) {
          this.db.updateDeliveryState({
            consumer: item.consumer,
            seq: item.seq,
            state: "dead",
            attempts: attemptNum,
            dueAt: failIso,
            lastError: errMsg,
            updatedAt: failIso,
          });
          dead += 1;
        } else {
          const delayMs = this.baseBackoffMs * Math.pow(2, attemptNum - 1);
          const nextDue = new Date(failNow.getTime() + delayMs).toISOString();
          this.db.updateDeliveryState({
            consumer: item.consumer,
            seq: item.seq,
            state: "failed",
            attempts: attemptNum,
            dueAt: nextDue,
            lastError: errMsg,
            updatedAt: failIso,
          });
          retried += 1;
        }
      }
    }

    return { processed, succeeded, retried, dead };
  }
}
