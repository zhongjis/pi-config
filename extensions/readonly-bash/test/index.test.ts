import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockContext } from "../../../test/fixtures/mock-context.js";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";

const bashMockState = vi.hoisted(() => ({
  createCalls: [] as string[],
  executeCalls: [] as Array<{
    boundCwd: string;
    toolCallId: string;
    params: { command: string; timeout?: number };
    signal: AbortSignal | undefined;
    onUpdate: unknown;
    ctx: { cwd: string };
  }>,
}));

const createBashToolDefinitionMock = vi.hoisted(() =>
  vi.fn((cwd: string) => {
    bashMockState.createCalls.push(cwd);
    return {
      name: "bash",
      label: "bash",
      execute: vi.fn(
        async (
          toolCallId: string,
          params: { command: string; timeout?: number },
          signal: AbortSignal | undefined,
          onUpdate: unknown,
          ctx: { cwd: string },
        ) => {
          bashMockState.executeCalls.push({
            boundCwd: cwd,
            toolCallId,
            params,
            signal,
            onUpdate,
            ctx,
          });
          return {
            content: [{ type: "text", text: `stdout for ${params.command}` }],
            details: { cwd, stderr: "ignored stderr", exitCode: 99 },
          };
        },
      ),
    };
  }),
);

vi.mock("@mariozechner/pi-coding-agent", async () => {
  const actual = await import("../../../test/stubs/pi-coding-agent.js");

  return {
    ...actual,
    createBashToolDefinition: createBashToolDefinitionMock,
  };
});

type ReadonlyBashTool = {
  name: string;
  label: string;
  description: string;
  execute: (
    toolCallId: string,
    params: { command: string; timeout?: number },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  }>;
};

function getReadonlyBashTool(): ReadonlyBashTool {
  const mock = createMockPi();
  returnToolInit(mock.pi as never);

  const tool = mock.tools.get("readonly_bash");
  expect(tool).toBeDefined();
  return tool as ReadonlyBashTool;
}

let returnToolInit: (pi: never) => void;

describe("readonly-bash validator", () => {
  beforeEach(async () => {
    const module = await import("../index.js");
    returnToolInit = module.default as (pi: never) => void;
  });

  it("tokenizes quoted arguments and assert helper returns normalized command", async () => {
    const { assertReadonlyBashCommand, tokenizeReadonlyBashCommand } = await import("../index.js");

    expect(tokenizeReadonlyBashCommand("rg 'quoted pattern' extensions")).toEqual([
      "rg",
      "quoted pattern",
      "extensions",
    ]);
    expect(assertReadonlyBashCommand("  ls -la  ")).toEqual({
      command: "ls -la",
      argv: ["ls", "-la"],
    });
  });

  it.each([
    "pwd",
    "ls -la",
    "find . -maxdepth 2 -type f",
    "fd README extensions",
    'rg "pattern" extensions',
    'grep -R "readonly" extensions/readonly-bash',
    "cat extensions/readonly-bash/README.md",
    "head -n 20 extensions/readonly-bash/README.md",
    "tail -n 20 extensions/readonly-bash/README.md",
    "sed -n '1,20p' file",
    "awk '{print $1}' extensions/readonly-bash/README.md",
    "jq . file.json",
    "wc -l extensions/readonly-bash/README.md",
    "sort package.json",
    "uniq file.txt",
    "cut -d: -f1 /etc/passwd",
    "file package.json",
    "stat package.json",
    "du -sh extensions",
    "df -h .",
    "git status",
    "git status --short",
    "git log --oneline -5",
    "git diff -- agents/chengfeng.md",
    "git show --stat HEAD",
    "git branch --show-current",
    "git rev-parse --show-toplevel",
    'git grep "readonly_bash"',
    "kubectl get pods",
    "kubectl get pods -o yaml",
    "kubectl -A get pods",
    "kubectl --all-namespaces=true get pods",
    "kubectl -n kube-system get pods",
    "kubectl -ndefault events",
    "kubectl --context prod --namespace=default describe pod web",
    "kubectl --kubeconfig /tmp/kubeconfig --request-timeout=5s api-resources",
    "kubectl logs deployment/web",
    "kubectl explain pods",
    "kubectl api-versions",
    "kubectl version",
    "kubectl top pods",
    "kubectl options",
    "flux get kustomizations",
    "flux get kustomizations -A",
    "flux --namespace flux-system get sources git",
    "flux -A get kustomizations",
    "flux -nflux-system tree kustomization app",
    "flux --context=prod --kubeconfig /tmp/config logs --kind HelmRelease",
    "flux --timeout 5s --log-level debug stats",
    "flux trace pod/web",
    "flux events",
    "flux version",
    "flux check",
    "flux export source git app",
  ])("allows read-only command: %s", async (command) => {
    const { validateReadonlyBashCommand } = await import("../index.js");

    const result = validateReadonlyBashCommand(command);

    expect(result).toMatchObject({ ok: true, command: command.trim() });
  });

  it.each([
    ["echo hi", "echo is outside the read-only allowlist"],
    ["rm -rf .", "rm is not allowed"],
    ["cat file > out", "redirection is not allowed"],
    ["cat < file", "redirection is not allowed"],
    ["echo hi | sh", "pipes and command chaining are not allowed"],
    ["pwd; rm -rf .", "command chaining is not allowed"],
    ["pwd && rm -rf .", "backgrounding and command chaining are not allowed"],
    ["pwd || rm -rf .", "pipes and command chaining are not allowed"],
    ["cmd=`echo rm`; $cmd", "command substitution is not allowed"],
    ["cmd=$(echo rm); $cmd", "parameter or command substitution is not allowed"],
    ["cat $" + "{HOME}/.bashrc", "parameter or command substitution is not allowed"],
    ["cat <(git status)", "redirection is not allowed"],
    ["ls\nrm -rf .", "newlines and control characters are not allowed"],
    ["find . -exec rm {} \\;", "shell escapes are not allowed"],
    ["find . -exec rm {}", "find command execution actions are not allowed"],
    ["find . -execdir cat {} \\;", "shell escapes are not allowed"],
    ["find . -execdir cat {}", "find command execution actions are not allowed"],
    ["find . -delete", "find output or mutation actions are not allowed"],
    ["xargs rm", "xargs is not allowed"],
    ["sudo ls /root", "sudo is not allowed"],
    ['eval "ls"', "eval is not allowed"],
    ["source ./script.sh", "source is not allowed"],
    [". ./script.sh", "shell sourcing is not allowed"],
    ["sed -i 's/a/b/' file", "sed requires -n for read-only use"],
    ["sed -ni 's/a/b/' file", "sed in-place editing is not allowed"],
    ["sed -n --in-place=.bak 's/a/b/' file", "sed in-place editing is not allowed"],
    ["sed -n '1w out' file", "sed write commands are not allowed"],
    ["sed -n '1e touch /tmp/x' file", "sed shell execution commands are not allowed"],
    ["sed -n 's/x/y/e' file", "sed shell execution commands are not allowed"],
    ["awk '{print > \"out\"}' file", "awk output redirection is not allowed"],
    ["git checkout main", "git checkout is not allowed"],
    ["git switch main", "git switch is not allowed"],
    ["git reset --hard", "git reset is not allowed"],
    ["git clean -fd", "git clean is not allowed"],
    ["git add .", "git add is not allowed"],
    ["git commit -m test", "git commit is not allowed"],
    ["git branch -D tmp", "git branch mutation options are not allowed"],
    ["git diff --output=out", "git diff output options are not allowed"],
    ["git pull", "git pull is not allowed"],
    ["git push", "git push is not allowed"],
    ["npm install", "npm package-manager commands are not allowed"],
    ["pnpm build", "pnpm package-manager commands are not allowed"],
    ["yarn run test", "yarn package-manager commands are not allowed"],
    ["bun run check", "bun package-manager commands are not allowed"],
    ["nix develop -c bash", "nix develop is not allowed"],
    ["nix build", "nix build is not allowed"],
    ["nix run nixpkgs#hello", "nix run is not allowed"],
    ["nh os switch", "nh os switch is not allowed"],
    ["python -c 'open(\"out\", \"w\").write(\"x\")'", "python is not allowed"],
    ["kubectl --namespace default apply -f deploy.yaml", "kubectl apply is not allowed"],
    ["kubectl", "kubectl requires an explicit read-only subcommand"],
    ["kubectl --bogus get pods", "kubectl unknown pre-subcommand option --bogus is not allowed"],
    ["kubectl -- get pods", "kubectl end-of-options marker before subcommand is not allowed"],
    ["kubectl get --raw /api/v1/pods", "kubectl --raw is not allowed"],
    ["kubectl get --raw=/api/v1/pods", "kubectl --raw is not allowed"],
    ["kubectl get pods --profile=cpu", "kubectl profiling options are not allowed"],
    ["kubectl get pods --profile-output out", "kubectl profiling options are not allowed"],
    ["kubectl get pods --cache-dir=/tmp/cache", "kubectl cache-dir options are not allowed"],
    ["kubectl get pods -w", "kubectl watch flags are not allowed"],
    ["kubectl events --watch", "kubectl watch flags are not allowed"],
    ["kubectl logs pod/web -f", "kubectl follow flags are not allowed"],
    ["kubectl exec pod/web -- whoami", "kubectl exec is not allowed"],
    ["flux --namespace flux-system reconcile kustomization app", "flux reconcile is not allowed"],
    ["flux", "flux requires an explicit read-only subcommand"],
    ["flux --bogus get sources", "flux unknown pre-subcommand option --bogus is not allowed"],
    ["flux -- get sources", "flux end-of-options marker before subcommand is not allowed"],
    ["flux get kustomizations --watch=true", "flux watch/follow flags are not allowed"],
    ["flux logs --follow", "flux watch/follow flags are not allowed"],
    ["flux completion bash", "flux completion is not allowed"],
  ])("denies unsafe command: %s", async (command, reason) => {
    const { assertReadonlyBashCommand, validateReadonlyBashCommand } = await import(
      "../index.js",
    );

    expect(validateReadonlyBashCommand(command)).toEqual({ ok: false, reason });
    expect(() => assertReadonlyBashCommand(command)).toThrow(`readonly_bash blocked: ${reason}`);
  });

  it("adds actionable guidance to rejected command errors", async () => {
    const { assertReadonlyBashCommand } = await import("../index.js");

    let error: unknown;
    try {
      assertReadonlyBashCommand("kubectl delete pod web");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("readonly_bash blocked: kubectl delete is not allowed");
    expect(message).toContain("Command: kubectl delete pod web");
    expect(message).toContain("How to fix:");
    expect(message).toContain("Use one non-mutating command only");
    expect(message).toContain("Local examples: ls -la");
    expect(message).toContain("Kubernetes examples: kubectl get pods -A");
    expect(message).not.toContain("Flux examples:");
    expect(message).toContain("will not run mutating or streaming commands");
  });

  it("renders guidance from the matching command family only", async () => {
    const { assertReadonlyBashCommand } = await import("../index.js");

    expect(() => assertReadonlyBashCommand("flux reconcile kustomization app")).toThrow(/Flux examples: flux get kustomizations -A/);
    expect(() => assertReadonlyBashCommand("flux reconcile kustomization app")).not.toThrow(/Kubernetes examples:/);
  });
});

describe("readonly-bash tool", () => {
  beforeEach(async () => {
    createBashToolDefinitionMock.mockClear();
    bashMockState.createCalls.length = 0;
    bashMockState.executeCalls.length = 0;

    const module = await import("../index.js");
    returnToolInit = module.default as (pi: never) => void;
  });

  it("registers exactly one restricted read-only non-sandbox tool", () => {
    const mock = createMockPi();
    returnToolInit(mock.pi as never);

    expect([...mock.tools.keys()]).toEqual(["readonly_bash"]);
    const tool = mock.tools.get("readonly_bash") as ReadonlyBashTool;
    expect(tool.name).toBe("readonly_bash");
    expect(tool.label).toContain("readonly_bash");
    expect(tool.description).toMatch(/restricted/i);
    expect(tool.description).toMatch(/read-only/i);
    expect(tool.description).toMatch(/not a security sandbox/i);
  });

  it("executes allowed commands through the wrapped bash tool with ctx cwd and default timeout", async () => {
    const tool = getReadonlyBashTool();
    const ctx = { ...createMockContext(), cwd: "/repo/worktree" };
    const signal = new AbortController().signal;
    const onUpdate = vi.fn();

    const result = await tool.execute(
      "call-1",
      { command: "pwd" },
      signal,
      onUpdate,
      ctx,
    );

    expect(createBashToolDefinitionMock).toHaveBeenCalledTimes(1);
    expect(createBashToolDefinitionMock).toHaveBeenCalledWith("/repo/worktree");
    expect(bashMockState.executeCalls).toHaveLength(1);
    expect(bashMockState.executeCalls[0]).toMatchObject({
      boundCwd: "/repo/worktree",
      toolCallId: "call-1",
      params: { command: "pwd", timeout: 30 },
      ctx: { cwd: "/repo/worktree" },
    });
    expect(bashMockState.executeCalls[0]?.signal).toBe(signal);
    expect(bashMockState.executeCalls[0]?.onUpdate).toEqual(expect.any(Function));
    expect(result).toMatchObject({
      content: [{ type: "text", text: "stdout for pwd" }],
      details: {
        cwd: "/repo/worktree",
        stdout: "stdout for pwd",
        stderr: "",
        exitCode: 0,
      },
    });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("passes explicit timeout for allowed commands", async () => {
    const tool = getReadonlyBashTool();
    const ctx = { ...createMockContext(), cwd: "/repo/worktree" };

    await tool.execute(
      "call-2",
      { command: "git status", timeout: 7 },
      undefined,
      undefined,
      ctx,
    );

    expect(bashMockState.executeCalls).toHaveLength(1);
    expect(bashMockState.executeCalls[0]?.params).toEqual({ command: "git status", timeout: 7 });
  });

  it("blocks denied commands before creating or executing the wrapped bash tool", async () => {
    const tool = getReadonlyBashTool();
    const ctx = { ...createMockContext(), cwd: "/repo/worktree" };

    await expect(
      tool.execute("call-3", { command: "rm -rf ." }, undefined, undefined, ctx),
    ).rejects.toThrow("readonly_bash blocked: rm is not allowed");

    expect(createBashToolDefinitionMock).not.toHaveBeenCalled();
    expect(bashMockState.executeCalls).toHaveLength(0);
  });
});
