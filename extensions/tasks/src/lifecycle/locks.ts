import type { TaskRuntime } from "./store-glue.js";

export function deleteSessionStoreFileIfEmpty(runtime: TaskRuntime): boolean {
  if (runtime.taskScope !== "session") return false;
  return runtime.store.deleteFileIfEmpty();
}
