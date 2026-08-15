import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const wrapperPath = join(repoRoot, "scripts", "pi-package-npm.sh");
const installScriptPath = join(repoRoot, "install.sh");

let tempRoot: string;
let fakeBin: string;
let commandLog: string;
let fakeHome: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "pi-package-npm-"));
  fakeBin = join(tempRoot, "bin");
  commandLog = join(tempRoot, "commands.log");
  fakeHome = join(tempRoot, "home");
  await mkdir(fakeBin, { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  await installFakeExecutables();
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("pi package manager wrapper", () => {
  it("preserves package-local pnpm workspace policy", async () => {
    const packageDir = await makePackageDir("pnpm-workspace", {
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "pnpm-workspace.yaml": "allowBuilds:\n  esbuild: true\n  protobufjs: false\n",
    });
    const workspacePath = join(packageDir, "pnpm-workspace.yaml");
    const before = await readFile(workspacePath);

    await runWrapper(packageDir, ["install"]);

    expect(await readCommands()).toEqual([["pnpm", "install"]]);
    expect(await readFile(workspacePath)).toEqual(before);
  });

  it("routes package managers without discarding local policy", async () => {
    const pnpmDir = await makePackageDir("mixed-locks", {
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "package-lock.json": "{}\n",
    });
    const bunDir = await makePackageDir("bun-lock", { "bun.lock": "" });
    const npmDir = await makePackageDir("npm-fallback", { "package-lock.json": "{}\n" });

    await runWrapper(pnpmDir, ["install"]);
    await runWrapper(bunDir, ["install"]);
    await runWrapper(npmDir, ["install"]);

    expect(await readCommands()).toEqual([
      ["pnpm", "install"],
      ["bun", "install"],
      ["npm", "install"],
    ]);
  });

  it("preserves the Plannotator build override", async () => {
    const packageDir = join(fakeHome, ".pi", "agent", "git", "github.com", "backnotprop", "plannotator");
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "bun.lock"), "");

    await runWrapper(packageDir, ["install"]);

    expect(await readCommands()).toEqual([
      ["bun", "install"],
      ["bun", "run", "build:pi"],
    ]);
  });

  it("forwards arguments and propagates manager failure", async () => {
    const packageDir = await makePackageDir("failing-pnpm", {
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });

    const result = runWrapper(packageDir, ["install", "--config.test=value with space"], {
      MANAGER_EXIT_CODE: "23",
    });

    await expect(result).rejects.toMatchObject({ code: 23 });
    expect(await readCommands()).toEqual([
      ["pnpm", "install", "--config.test=value with space"],
    ]);
  });

  it("keeps install.sh pnpm behavior aligned", async () => {
    const source = await readFile(installScriptPath, "utf8");

    expect(source).toContain("pnpm install");
    expect(source).not.toContain("pnpm install --ignore-workspace");
  });
});

async function makePackageDir(name: string, files: Record<string, string>): Promise<string> {
  const packageDir = join(tempRoot, name);
  await mkdir(packageDir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(packageDir, path), content);
  }
  return packageDir;
}

async function runWrapper(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("bash", [wrapperPath, ...args], {
    cwd,
    env: {
      ...process.env,
      ...env,
      HOME: fakeHome,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      COMMAND_LOG: commandLog,
    },
  });
}

async function readCommands(): Promise<string[][]> {
  const raw = await readFile(commandLog, "utf8");
  const tokens = raw.split("\0");
  const calls: string[][] = [];
  let current: string[] | undefined;

  for (const token of tokens) {
    if (token === "CALL") {
      current = [];
    } else if (token === "END") {
      if (current) calls.push(current);
      current = undefined;
    } else if (current) {
      current.push(token);
    }
  }
  return calls;
}

async function installFakeExecutables(): Promise<void> {
  const nixPath = join(fakeBin, "nix");
  await writeFile(
    nixPath,
    `#!/usr/bin/env bash
set -euo pipefail
args=("$@")
for ((index = 0; index < \${#args[@]}; index++)); do
  if [ "\${args[index]}" = "-c" ]; then
    exec "\${args[@]:index + 1}"
  fi
done
printf 'fake nix: missing -c\\n' >&2
exit 64
`,
  );
  await chmod(nixPath, 0o755);

  const managerPath = join(fakeBin, "fake-manager");
  await writeFile(
    managerPath,
    `#!/usr/bin/env bash
set -euo pipefail
{
  printf 'CALL\\0%s\\0' "$MANAGER_NAME"
  printf '%s\\0' "$@"
  printf 'END\\0'
} >> "$COMMAND_LOG"
exit "\${MANAGER_EXIT_CODE:-0}"
`,
  );
  await chmod(managerPath, 0o755);

  for (const manager of ["npm", "pnpm", "bun"]) {
    await writeFile(join(fakeBin, manager), `#!/usr/bin/env bash
MANAGER_NAME="${manager}" exec "${managerPath}" "$@"
`);
    await chmod(join(fakeBin, manager), 0o755);
  }
}
