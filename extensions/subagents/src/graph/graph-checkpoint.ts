import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Atomic replacement, not an exactly-once guarantee for actions using the checkpoint. */
export function writeCheckpointAtomic(path: string, data: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, data, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function syncDirectory(path: string): void {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    // Some filesystems/platforms do not support directory fsync. Actual I/O
    // failures still propagate, even though the new complete file is visible.
    if (error instanceof Error && "code" in error &&
        (error.code === "EINVAL" || error.code === "ENOTSUP" ||
         (process.platform === "win32" && (error.code === "EPERM" || error.code === "EISDIR")))) return;
    throw error;
  }
}
