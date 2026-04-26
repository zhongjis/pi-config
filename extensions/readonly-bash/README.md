# readonly_bash contract

`readonly_bash` is a Pi tool contract for running a narrowly validated shell command when an agent needs local read-only inspection. It is a best-effort accidental-mutation guard, not a security sandbox. It must not be treated as protection against hostile input, shell escape bugs, kernel/filesystem side effects, or commands whose read-only behavior depends on external configuration.

## Registration and opt-in

The extension path is `extensions/readonly-bash`, while the registered tool name is `readonly_bash`. The tool registers globally when the extension loads, but active-tool filtering keeps it disabled by default for agents and modes that do not opt in. Enable it by adding the exact extension id `readonly_bash` to frontmatter, for example `extensions: readonly_bash`.

## Command validation contract

Validation is deny-by-default. A command is accepted only when it matches one supported command family and does not contain rejected shell syntax or rejected command classes.

### Allowed command families

Allowed families are intentionally conservative:

- Directory inspection: `pwd`, `ls`, `find` without `-exec` or `-execdir`, `fd`.
- Search: `rg`, `grep`, `git grep`.
- File/content viewing: `cat`, `head`, `tail`, `sed -n`, read-only `awk` programs.
- Structured data inspection: `jq`.
- Text/metadata inspection: `wc`, `sort`, `uniq`, `cut`, `file`, `stat`, `du`, `df`.
- Read-only git: `git status`, `git log`, `git diff`, `git show`, `git branch`, `git rev-parse`, `git grep`.

`awk` is allowed only for read-only printing/filtering/aggregation. `sed` is allowed only with `-n`; in-place editing or write-like flags are rejected.

### Rejected syntax and classes

The validator must reject commands containing shell composition, command substitution, or output mutation syntax, including:

- Pipes and chaining: `|`, `;`, `&&`, `||`.
- Redirection: `>`, `>>`, `<`, `2>`, `&>`, here-docs, here-strings.
- Command substitution and dynamic execution: backticks, `$()`, process substitution `<(...)` or `>(...)`, `${...}`, `eval`.
- Newline or other control characters.
- `source` / `.` shell sourcing.
- `xargs`, because it can convert read-only output into arbitrary commands.
- `sudo` or privilege-changing wrappers.
- Mutating commands such as `rm`, `mv`, `cp`, `touch`, `mkdir`, `rmdir`, `chmod`, `chown`, `ln`, editors, service managers, network download-and-execute flows, and script interpreters used for mutation.

Additional default rejections:

- `find -exec` and `find -execdir` are disallowed.
- Package-manager install/build/run commands are disallowed by default, including `npm`, `pnpm`, `yarn`, and `bun` install/add/remove/build/run/test-style invocations.
- `nix build`, `nix develop`, and `nix run` are disallowed by default.
- `nh os switch` is disallowed by default.
- Mutable git commands are disallowed by default, including `git add`, `git checkout`, `git switch`, `git restore`, `git reset`, `git clean`, `git commit`, `git merge`, `git rebase`, `git pull`, `git push`, `git fetch`, `git tag`, and `git remote` mutations.

## Execution behavior

- Commands run from `ctx.cwd`.
- The tool accepts an optional bounded timeout; implementation should enforce a safe default timeout when none is provided.
- The implementation should pass an abort signal to the spawned process where the Pi/runtime execution API supports it.
- Successful execution returns a stable result object with at least `stdout`, `stderr`, and `exitCode` fields.
- Non-zero command exits are command results, not validator failures; they should still return `stdout`, `stderr`, and `exitCode` unless the runtime itself fails.
- Validator denials must throw a tool error with a stable message such as `readonly_bash blocked: <reason>`.

## Validator test matrix

Use these cases as the minimum focused validator matrix for implementation and tests.

| Command | Expected | Reason |
| --- | --- | --- |
| `pwd` | allow | Current working directory inspection. |
| `ls -la` | allow | Directory listing. |
| `find . -maxdepth 2 -type f` | allow | Read-only file discovery without exec. |
| `fd README extensions` | allow | Read-only file discovery. |
| `rg "readonly_bash" extensions` | allow | Read-only search. |
| `grep -R "readonly" extensions/readonly-bash` | allow | Read-only search. |
| `cat extensions/readonly-bash/README.md` | allow | File viewing. |
| `head -n 20 extensions/readonly-bash/README.md` | allow | File viewing. |
| `tail -n 20 extensions/readonly-bash/README.md` | allow | File viewing. |
| `sed -n '1,20p' extensions/readonly-bash/README.md` | allow | Explicit non-printing read-only sed usage. |
| `awk '{print $1}' extensions/readonly-bash/README.md` | allow | Read-only awk printing. |
| `jq . package.json` | allow | JSON inspection. |
| `wc -l extensions/readonly-bash/README.md` | allow | Metadata/text counting. |
| `sort package.json` | allow | Read-only text processing. |
| `uniq file.txt` | allow | Read-only text processing. |
| `cut -d: -f1 /etc/passwd` | allow | Read-only text slicing. |
| `file package.json` | allow | File metadata inspection. |
| `stat package.json` | allow | File metadata inspection. |
| `du -sh extensions` | allow | Disk usage inspection. |
| `df -h .` | allow | Filesystem usage inspection. |
| `git status --short` | allow | Read-only git state. |
| `git log --oneline -5` | allow | Read-only git history. |
| `git diff -- agents/chengfeng.md` | allow | Read-only git diff. |
| `git show --stat HEAD` | allow | Read-only git object inspection. |
| `git branch --show-current` | allow | Read-only branch inspection. |
| `git rev-parse --show-toplevel` | allow | Read-only git metadata. |
| `git grep "readonly_bash"` | allow | Read-only git search. |
| `echo hi` | reject | `echo` is outside the allowlist. |
| `rm -rf .` | reject | Mutating command. |
| `cat file > out` | reject | Output redirection. |
| `cat < file` | reject | Input redirection. |
| `echo hi \| sh` | reject | Pipe and shell execution. |
| `pwd; rm -rf .` | reject | Command chaining. |
| `pwd && rm -rf .` | reject | Command chaining. |
| `pwd \|\| rm -rf .` | reject | Command chaining. |
| ``cmd=`echo rm`; $cmd`` | reject | Backtick command substitution. |
| `cmd=$(echo rm); $cmd` | reject | `$()` command substitution and chaining. |
| `cat ${HOME}/.bashrc` | reject | Brace/parameter substitution. |
| `cat <(git status)` | reject | Process substitution. |
| `printf 'a\\nb'` | reject | `printf` outside allowlist; newline/control bypass cases must be rejected. |
| `ls\\nrm -rf .` | reject | Newline injection. |
| `find . -exec rm {} \;` | reject | `find -exec` mutation path. |
| `find . -execdir cat {} \;` | reject | `find -execdir` arbitrary execution path. |
| `xargs rm` | reject | `xargs` arbitrary execution path. |
| `sudo ls /root` | reject | Privilege-changing wrapper. |
| `eval "ls"` | reject | Dynamic execution. |
| `source ./script.sh` | reject | Shell sourcing. |
| `. ./script.sh` | reject | Shell sourcing. |
| `sed -i 's/a/b/' file` | reject | In-place mutation. |
| `awk '{print > "out"}' file` | reject | Awk output mutation. |
| `git checkout main` | reject | Mutable git command. |
| `git switch main` | reject | Mutable git command. |
| `git reset --hard` | reject | Mutable git command. |
| `git clean -fd` | reject | Mutable git command. |
| `git add .` | reject | Mutable git command. |
| `git commit -m test` | reject | Mutable git command. |
| `git pull` | reject | Mutable/network git command. |
| `git push` | reject | Mutable/network git command. |
| `npm install` | reject | Package-manager install. |
| `pnpm build` | reject | Package-manager build. |
| `yarn run test` | reject | Package-manager run. |
| `bun run check` | reject | Package-manager run. |
| `nix develop -c bash` | reject | Nix develop/run class. |
| `nix build` | reject | Nix build class. |
| `nix run nixpkgs#hello` | reject | Nix run class. |
| `nh os switch` | reject | Host mutation. |
| `python -c 'open("out", "w").write("x")'` | reject | Interpreter mutation path outside allowlist. |
