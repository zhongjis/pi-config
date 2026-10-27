import { describe, expect, it } from "vitest";
import { evaluateBashPolicy } from "../src/bash-policy.js";

function outcome(command: string) {
	return evaluateBashPolicy({ command, effectiveCwd: "/repo" });
}

const SCHEMA = "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name;";
const SQLITE = `sqlite3 -batch -readonly -init /dev/null 'file:/snapshot.db?mode=ro&immutable=1' "${SCHEMA}"`;

describe("bounded diagnostic inspection", () => {
	it.each([
		"journalctl --user -u sample.service --no-pager -n 120",
		"journalctl --no-pager -n 1 --user -u sample.service",
		"systemctl --user show sample.service -p ExecStart -p FragmentPath -p ActiveEnterTimestamp --no-pager",
		"systemctl --user status sample.service --no-pager",
		SQLITE,
	])("allows validated direct diagnostics: %s", (command) => {
		expect(outcome(command)).toEqual({ kind: "allow" });
	});

	it.each([
		"journalctl --user -u sample.service -n 120",
		"journalctl --user -u sample.service --no-pager -n 0",
		"journalctl --user -u sample.service --no-pager -n 10001",
		"journalctl --user -u sample.service --no-pager -n 20 --output=json",
		"journalctl --user -u sample.service --no-pager -n 20 --vacuum-time=1s",
		"journalctl --user -u sample.service --no-pager -n 20 --rotate",
		"systemctl --user restart sample.service --no-pager",
		"systemctl --user status sample.service",
		"systemctl --user show sample.service --no-pager --now",
		"systemctl --user show sample.service --no-pager -p Environment",
		"systemctl --user show --no-pager -p ExecStart",
		"systemctl --user status sample.service --no-pager extra.service",
		"env systemctl --user status sample.service --no-pager",
		"/bin/systemctl --user status sample.service --no-pager",
		"'systemctl' --user status sample.service --no-pager",
		"systemctl --user status $UNIT --no-pager",
		"systemctl --user status sample.service --no-pager; systemctl restart sample.service",
		"journalctl --user -u sample.service --no-pager -n 20 | unknown",
		`sqlite3 -readonly /snapshot.db "${SCHEMA}"`,
		SQLITE.replace("-init /dev/null", "-init /tmp/startup.sql"),
		SQLITE.replace("-readonly ", ""),
		SQLITE.replace("immutable=1", "immutable=0"),
		SQLITE.replace("mode=ro", "mode=rw"),
		SQLITE.replace("immutable=1", "immutable=1&vfs=helper"),
		SQLITE.replace(SCHEMA, "SELECT load_extension('helper');"),
		SQLITE.replace(SCHEMA, "SELECT writefile('/tmp/out', 'x');"),
		SQLITE.replace(SCHEMA, ".tables"),
		SQLITE.replace(SCHEMA, `${SCHEMA} DROP TABLE example;`),
		`${SQLITE} -cmd '.shell touch /tmp/out'`,
		`env ${SQLITE}`,
		`python3 -c 'import sqlite3'`,
	])("never fast-approves unsupported or effectful siblings: %s", (command) => {
		expect(outcome(command).kind).not.toBe("allow");
	});

	it("keeps unknown ordinary journal read flags on the classifier path", () => {
		expect(outcome("journalctl --user -u sample.service --no-pager -n 20 --output=json")).toEqual({ kind: "defer" });
	});

	it.each([
		"echo x 2>&1",
		"journalctl --user -u sample.service --no-pager -n 20 2>&1 | sed -E 's/token/redacted/g'",
		"echo '2>&1'",
	])("does not mistake exact stderr duplication or quoted data for a file write: %s", (command) => {
		expect(outcome(command)).toEqual({ kind: "defer" });
	});

	it.each([
		"echo x 2>&1 >out", "echo x 2>&10", "echo x 2>&1out", "echo x 12>&1",
		"echo x >&1", "echo x 2>& 1", "echo x 2>>out", "echo x 2>out",
		"echo x 2>&1 | rm out", "echo x 2>&1; python3 script.py",
	])("retains independent hazards beside fd duplication: %s", (command) => {
		expect(outcome(command).kind).toBe("block");
	});
});
