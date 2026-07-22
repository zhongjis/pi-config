import type { AgentRecord } from "../types.js";
import type { AgentLifecycleLease } from "./agent-lifecycle-store.js";

export interface LifecycleDeliveryStore {
  markConsumed(lease: AgentLifecycleLease, updatedAt: number): Promise<unknown>;
  markNotified(lease: AgentLifecycleLease, updatedAt: number): Promise<unknown>;
  isNotificationPending(lease: AgentLifecycleLease): Promise<boolean>;
}

export interface LifecycleDeliveryRepository {
  getLifecycleStore(id: string): LifecycleDeliveryStore | undefined;
}

function requireLease(record: AgentRecord): AgentLifecycleLease {
  if (!record.lifecycleLease) {
    throw new Error(`Durable lifecycle lease is unavailable for ${record.id}`);
  }
  return record.lifecycleLease;
}

function publishConsumed(record: AgentRecord): void {
  if (record.run) record.run.publish({ kind: "consumed" });
  else record.resultConsumed = true;
}

function publishNotified(record: AgentRecord): void {
  if (record.run) record.run.publish({ kind: "notified" });
  else record.notified = true;
}

/** Commit durable consumption before acknowledging it in the runtime projection. */
export async function consumeTerminalResult(
  repository: LifecycleDeliveryRepository,
  record: AgentRecord,
  now: () => number = Date.now,
): Promise<void> {
  const store = repository.getLifecycleStore(record.id);
  if (store) await store.markConsumed(requireLease(record), now());
  publishConsumed(record);
}

async function isNotificationPending(
  repository: LifecycleDeliveryRepository,
  record: AgentRecord,
): Promise<boolean> {
  const store = repository.getLifecycleStore(record.id);
  if (store) return store.isNotificationPending(requireLease(record));
  return !record.resultConsumed && !record.notified;
}

async function markNotificationDelivered(
  repository: LifecycleDeliveryRepository,
  record: AgentRecord,
  now: () => number,
): Promise<void> {
  const store = repository.getLifecycleStore(record.id);
  if (store) await store.markNotified(requireLease(record), now());
  publishNotified(record);
}

/**
 * Resolve serialized durable eligibility, send outside the store queue, then commit notified.
 * A successful send followed by mark failure intentionally leaves notified=false: delivery is
 * at-least-once, so a restart or later idle flush may duplicate the notification.
 */
export async function deliverCompletionNotification(
  repository: LifecycleDeliveryRepository,
  candidates: readonly AgentRecord[],
  send: (pending: readonly AgentRecord[]) => void | Promise<void>,
  now: () => number = Date.now,
): Promise<AgentRecord[]> {
  const pending: AgentRecord[] = [];
  for (const record of candidates) {
    if (await isNotificationPending(repository, record)) pending.push(record);
  }
  if (pending.length === 0) return pending;

  await send(pending);
  for (const record of pending) await markNotificationDelivered(repository, record, now);
  return pending;
}
