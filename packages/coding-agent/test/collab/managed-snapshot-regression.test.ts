import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Each child owns its clock, transport observers and config root. No module mock,
// environment override or WebSocket replacement can leak into the full suite.
for (const scenario of [
	"disconnected-switch",
	"disconnected-render",
	"disconnected-todos",
	"deadline",
	"recovery-bound",
	"recovery-unbound",
]) {
	test(`snapshot generation: ${scenario}`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-snapshot-regression-"));
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "managed-snapshot-regression.fixture.ts"), scenario],
			{
				cwd: path.resolve(import.meta.dir, "../.."),
				env: {
					PATH: process.env.PATH,
					HOME: root,
					PI_CODING_AGENT_DIR: path.join(root, "agent"),
					PI_NO_TITLE: "1",
					XDG_CONFIG_HOME: path.join(root, "config"),
					XDG_CACHE_HOME: path.join(root, "cache"),
					XDG_DATA_HOME: path.join(root, "data"),
					XDG_STATE_HOME: path.join(root, "state"),
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const deadline = setTimeout(() => child.kill(), 20_000);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: `PASS ${scenario}\n`, stderr: "" });
		} finally {
			clearTimeout(deadline);
			child.kill();
			await child.exited;
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 25_000);
}
