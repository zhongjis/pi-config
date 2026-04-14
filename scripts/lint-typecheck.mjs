import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const rootChecks = [
  ["pnpm", ["run", "lint"]],
  ["pnpm", ["exec", "tsc", "--noEmit", "-p", "tsconfig.json"]]
];

const packageDirs = [];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

for (const [command, args] of rootChecks) {
  await run(command, args);
}

for (const packageDir of packageDirs) {
  const packageJson = JSON.parse(await readFile(`${packageDir}/package.json`, "utf8"));
  const scripts = packageJson.scripts ?? {};

  for (const scriptName of ["lint", "typecheck"]) {
    if (!scripts[scriptName]) continue;
    await run("pnpm", ["--dir", packageDir, scriptName]);
  }
}
