import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// A malformed frame must not take the test runner down through postmortem's
// fatal unhandled-rejection hook. Each case also gets its own native registry,
// journal, auth database, environment and real loopback WebSocket relay.
async function runScenario(scenario: string): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-managed-protocol-"));
	const child = Bun.spawn(
		[process.execPath, path.join(import.meta.dir, "managed-protocol-regression.fixture.ts"), scenario],
		{
			cwd: root,
			env: {
				PATH: process.env.PATH,
				TMPDIR: root,
				HOME: root,
				XDG_CONFIG_HOME: path.join(root, "config"),
				XDG_CACHE_HOME: path.join(root, "cache"),
				XDG_STATE_HOME: path.join(root, "state"),
				PI_CODING_AGENT_DIR: path.join(root, "agent"),
				FIXTURE_DIR: root,
				NO_COLOR: "1",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			// Only a hung-child watchdog; all scenario ordering uses explicit signals.
			timeout: 20_000,
			killSignal: "SIGKILL",
		},
	);
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	try {
		const exitCode = await child.exited;
		const output = await stdout;
		const errors = await stderr;
		expect({ exitCode, output, errors }).toMatchObject({ exitCode: 0, output: `PASS ${scenario}\n` });
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		await fs.rm(root, { recursive: true, force: true });
	}
}

test(
	"an unauthenticated encrypted null frame cannot kill a managed host or prevent a later authenticated request",
	() => runScenario("managed-null"),
	25_000,
);

test(
	"an ordinary unbound host still accepts native prompts after malformed encrypted traffic",
	() => runScenario("unbound-null"),
	25_000,
);

test(
	"cross-principal cancellation returns the target turn, not the caller's same-ID completed receipt, while settlement is pending",
	() => runScenario("cross-principal-cancel"),
	25_000,
);

test(
	"authorization completing after its target settles cannot abort a successor belonging to another principal",
	() => runScenario("late-cancel-authorization"),
	25_000,
);
