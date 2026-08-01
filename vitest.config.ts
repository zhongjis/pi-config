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
            "@earendil-works/pi-ai/compat": resolve(rootDir, "test/stubs/pi-ai.ts"),
            "@earendil-works/pi-ai": resolve(rootDir, "test/stubs/pi-ai.ts"),
            "@earendil-works/pi-agent-core": resolve(rootDir, "test/stubs/pi-agent-core.ts"),
            "@earendil-works/pi-coding-agent": resolve(rootDir, "test/stubs/pi-coding-agent.ts"),
            "@earendil-works/pi-tui": resolve(rootDir, "test/stubs/pi-tui.ts")
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
            "test/integration/**",
            "extensions/subagents-new/test/**/*e2e*.test.ts"
          ],
          setupFiles: ["test/setup-require-stubs.ts"],
          server: {
            deps: {
              inline: [/@earendil-works/, /@mariozechner/]
            }
          }
        }
      },
      {
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
              inline: [/@earendil-works/, /@mariozechner/]
            }
          }
        }
      },
      {
        test: {
          name: "subagents-e2e",
          environment: "node",
          globals: true,
          include: [
            "extensions/subagents-new/test/**/*e2e*.test.ts"
          ],
          exclude: [
            "**/node_modules/**"
          ],
          testTimeout: 30_000,
          server: {
            deps: {
              inline: [/@earendil-works/, /@mariozechner/]
            }
          }
        }
      }
    ]
  }
});
