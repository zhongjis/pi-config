/**
 * Vitest setup file — removes the repository-location variables git exports to hooks
 * (`git rev-parse --local-env-vars`). Without this, a test that runs `git init` or
 * `git config` in a temp dir during a pre-push from a worktree writes into the host
 * repository instead (for example setting core.bare or a fixture user.email).
 */
for (const key of [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_WORK_TREE", "GIT_IMPLICIT_WORK_TREE", "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE", "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_PREFIX",
  "GIT_SHALLOW_FILE", "GIT_COMMON_DIR",
]) delete process.env[key];
