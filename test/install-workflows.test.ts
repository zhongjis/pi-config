import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const bashPath = process.env.PATH?.split(":")
  .map((directory) => join(directory, "bash"))
  .find(existsSync);

if (!bashPath) throw new Error("bash is unavailable");

let tempRoot: string;
let fixtureRepo: string;
let fakeHome: string;
let fakeBin: string;
let workflowSource: string;
let workflowTarget: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "install workflows "));
  fixtureRepo = join(tempRoot, "fixture repo");
  fakeHome = join(tempRoot, "fake home");
  fakeBin = join(tempRoot, "stub bin");
  workflowSource = join(fixtureRepo, "workflows");
  workflowTarget = join(fakeHome, ".pi", "agent", "workflows");

  await mkdir(workflowSource, { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(workflowSource, "deep-research.js"), "export default {};\n");
  await writeFile(
    join(fixtureRepo, "install.sh"),
    await readFile(join(repoRoot, "install.sh")),
  );
  await chmod(join(fixtureRepo, "install.sh"), 0o755);
  await writeFile(
    join(fakeBin, "nix"),
    "#!/usr/bin/env bash\nprintf 'unexpected nix invocation\\n' >&2\nexit 99\n",
  );
  await chmod(join(fakeBin, "nix"), 0o755);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("install.sh workflow linking", () => {
  it("creates the exact workflow link once and leaves it unchanged on repeat", async () => {
    await runInstaller();

    expect(await readlink(workflowTarget)).toBe(workflowSource);
    expect(await readFile(join(workflowTarget, "deep-research.js"), "utf8")).toBe(
      "export default {};\n",
    );
    await expect(lstat(join(workflowTarget, "workflows"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const before = await lstat(workflowTarget);
    await runInstaller();
    const after = await lstat(workflowTarget);

    expect(after.ino).toBe(before.ino);
    expect(await readlink(workflowTarget)).toBe(workflowSource);
  });

  it("replaces wrong and dangling workflow symlinks", async () => {
    await mkdir(join(fakeHome, ".pi", "agent"), { recursive: true });
    const wrongSource = join(tempRoot, "wrong workflows");
    await mkdir(wrongSource);
    await symlink(wrongSource, workflowTarget);

    await runInstaller();
    expect(await readlink(workflowTarget)).toBe(workflowSource);

    await rm(workflowTarget);
    await symlink(join(tempRoot, "missing workflows"), workflowTarget);

    await runInstaller();
    expect(await readlink(workflowTarget)).toBe(workflowSource);
  });

  it.each(["file", "empty directory", "nonempty directory"])(
    "rejects an existing workflow %s without changing it",
    async (kind) => {
      await mkdir(join(fakeHome, ".pi", "agent"), { recursive: true });
      let before: Awaited<ReturnType<typeof lstat>>;
      let contents: string | undefined;

      if (kind === "file") {
        await writeFile(workflowTarget, "keep this file\n");
        contents = await readFile(workflowTarget, "utf8");
      } else {
        await mkdir(workflowTarget);
        if (kind === "nonempty directory") {
          await writeFile(join(workflowTarget, "keep.txt"), "keep this directory\n");
          contents = await readFile(join(workflowTarget, "keep.txt"), "utf8");
        }
      }
      before = await lstat(workflowTarget);

      const result = await runInstallerFailure();

      expect(result.stderr).toContain("Refusing to replace non-symlink destination");
      const after = await lstat(workflowTarget);
      expect(after.ino).toBe(before.ino);
      expect(after.isSymbolicLink()).toBe(false);
      if (kind === "file") {
        expect(await readFile(workflowTarget, "utf8")).toBe(contents);
      }
      if (kind === "empty directory") {
        expect((await lstat(workflowTarget)).isDirectory()).toBe(true);
      }
      if (kind === "nonempty directory") {
        expect(await readFile(join(workflowTarget, "keep.txt"), "utf8")).toBe(contents);
      }
    },
  );
});

async function runInstaller(): Promise<void> {
  await execFileAsync(bashPath, [join(fixtureRepo, "install.sh")], {
    cwd: fixtureRepo,
    env: installerEnv(),
  });
}

async function runInstallerFailure(): Promise<{ stderr: string }> {
  try {
    await runInstaller();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== 1 ||
      !("stderr" in error) ||
      typeof error.stderr !== "string"
    ) {
      throw error;
    }
    return { stderr: error.stderr };
  }

  throw new Error("installer unexpectedly succeeded");
}

function installerEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: fakeHome,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  };
}
