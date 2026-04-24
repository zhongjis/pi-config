import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: {
            "@mariozechner/pi-ai": resolve(rootDir, "test/stubs/pi-ai.ts"),
            "@mariozechner/pi-agent-core": resolve(rootDir, "test/stubs/pi-agent-core.ts"),
            "@mariozechner/pi-coding-agent": resolve(rootDir, "test/stubs/pi-coding-agent.ts"),
            "@mariozechner/pi-tui": resolve(rootDir, "test/stubs/pi-tui.ts")
          }
        },
        test: {
          name: "unit",
          environment: "node",
          globals: true,
          include: [
            "test/**/*.test.ts",
            "extensions/**/*.test.ts"
          ],
          exclude: [
            "**/node_modules/**",
            ".omx/**",
            "sessions/**",
            "test/integration/**"
          ],
          setupFiles: ["test/setup-require-stubs.ts"],
          server: {
            deps: {
              inline: [/@mariozechner/]
            }
          }
        }
      },
      {
        resolve: {
          alias: {
            "@marcfargas/pi-test-harness": resolve(rootDir, "node_modules/@marcfargas/pi-test-harness/src/index.ts"),
          }
        },
        test: {
          name: "integration",
          environment: "node",
          globals: true,
          include: [
            "test/integration/**/*.test.ts"
          ],
          exclude: [
            "**/node_modules/**"
          ],
          testTimeout: 30_000,
          server: {
            deps: {
              inline: [/@mariozechner/, /@marcfargas/]
            }
          }
        }
      }
    ]
  }
});
