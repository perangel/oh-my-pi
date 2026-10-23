import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { ServerWebSocket } from "bun";
import { MANAGED_COLLAB_VERSION, type ManagedCollabIdentity } from "@oh-my-pi/pi-wire";
import type { BoundCollabGuestOptions } from "../../src/collab/bound-types";
import { generateRoomKey, importRoomKey, open, seal } from "../../src/collab/crypto";
import { CollabGuestLink } from "../../src/collab/guest";
import {
	COLLAB_PROTO,
	formatCollabLink,
	packEnvelope,
	unpackEnvelope,
	type CollabFrame,
} from "../../src/collab/protocol";
import { CollabSocket } from "../../src/collab/relay-client";
import { Settings } from "../../src/config/settings";
import type { InteractiveModeContext } from "../../src/modes/types";
import type { AgentSessionEvent } from "../../src/session/agent-session";

// Standalone child only: fake time controls retry/backoff and the reconnect budget,
// while real WebSocket I/O, AES-GCM, replica writes and guest frame application run.
// No sleeps decide when a snapshot/close/frame has arrived.
class Clock {
	#now = 0;
	#timers = new Map<Timer, { at: number; run: () => void }>();
	#originalSet = globalThis.setTimeout;
	#originalClear = globalThis.clearTimeout;
	#originalRandom = Math.random;
	#knownTimers = new WeakSet<object>();
	constructor() {
		globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
			const timer = {
				ref: () => timer,
				unref: () => timer,
				hasRef: () => true,
			} as unknown as Timer;
			this.#timers.set(timer, { at: this.#now + delay, run: () => callback(...args) });
			this.#knownTimers.add(timer);
			return timer;
		}) as typeof setTimeout;
		globalThis.clearTimeout = ((timer: Timer | undefined) => {
			if (timer && this.#knownTimers.has(timer)) {
				this.#timers.delete(timer);
				return;
			}
			this.#originalClear(timer);
		}) as typeof clearTimeout;
		Math.random = () => 0.5;
	}
	advance(milliseconds: number): void {
		const end = this.#now + milliseconds;
		for (;;) {
			const due = [...this.#timers].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			this.#now = due[1].at;
			this.#timers.delete(due[0]);
			due[1].run();
		}
		this.#now = end;
	}
	restore(): void {
		this.#timers.clear();
		globalThis.setTimeout = this.#originalSet;
		globalThis.clearTimeout = this.#originalClear;
		Math.random = this.#originalRandom;
	}
}

const scenario = process.argv[2];
const stage = scenario === "disconnected-render" ? "render" : scenario === "disconnected-todos" ? "todos" : "switch";
const unbound = scenario === "recovery-unbound";
const recovering = scenario === "recovery-bound" || unbound;
const identity: ManagedCollabIdentity = {
	binding: "snapshot-scope",
	hostEpoch: "epoch",
	childId: "child",
	sessionId: "snapshot-session",
	instanceId: "instance",
	generation: 1,
};
const rawKey = generateRoomKey();
const key = await importRoomKey(rawKey);
const clock = new Clock();
const peers: ServerWebSocket<{ index: number }>[] = [];
const inbound: CollabFrame[] = [];
const delivered: CollabFrame[] = [];
let transportError: unknown;
let closes = 0;

// Observation only: preserve the production callbacks and every frame. This
// barrier proves old frames really reached the guest's serialized apply queue
// before disconnect; it does not synthesize, forward or apply frames itself.
const originalConnect = CollabSocket.prototype.connect;
CollabSocket.prototype.connect = function (): void {
	const onFrame = this.onFrame;
	const onClose = this.onClose;
	this.onFrame = (frame, peer) => {
		onFrame?.(frame, peer);
		delivered.push(frame);
	};
	this.onClose = (reason, reconnect) => {
		onClose?.(reason, reconnect);
		closes++;
	};
	originalConnect.call(this);
};
const server = Bun.serve<{ index: number }>({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request, server) {
		if (server.upgrade(request, { data: { index: peers.length } })) return;
		return new Response(null, { status: 400 });
	},
	websocket: {
		open(ws) {
			peers.push(ws);
		},
		message(_ws, data) {
			if (typeof data === "string") return;
			const envelope = unpackEnvelope(new Uint8Array(data));
			if (!envelope) throw new Error("Missing encrypted envelope");
			void open(key, envelope.payload)
				.then(frame => inbound.push(frame))
				.catch(error => {
					transportError = error;
				});
		},
	},
});
const link = formatCollabLink(`ws://127.0.0.1:${server.port}`, "0123456789abcdef", rawKey);
const blocked = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
let paused = false;
let localFile: string | null = null;
let activeTitle = "";
const activations: string[] = [];
const snapshots: string[] = [];
const events: string[] = [];
const errors: string[] = [];
const calls = { switch: 0, render: 0, todos: 0 };
let persisted = 0;
let closed = 0;
async function activationSeam(at: "switch" | "render" | "todos"): Promise<void> {
	calls[at]++;
	if (at === stage && calls[at] === 2) {
		paused = true;
		blocked.resolve();
		await release.promise;
	}
}
const context = {
	settings: Settings.isolated(),
	sessionManager: {
		getSessionFile: () => localFile,
		getSessionName: () => "local",
		getCwd: () => process.cwd(),
	},
	session: {
		disableLocalExecution() {},
		async switchSession(file: string) {
			// Consume the actual replica JSONL written by the production guest.
			const header = JSON.parse((await Bun.file(file).text()).split("\n")[0]) as { title: string };
			activeTitle = header.title;
			activations.push(activeTitle);
			await activationSeam("switch");
			localFile = file;
			return true;
		},
		async newSession() {
			localFile = null;
			return true;
		},
		messages: [],
		agent: { state: {}, setModel() {}, setThinkingLevel() {}, setDisableReasoning() {} },
	},
	pendingTools: new Map(),
	pendingMessagesContainer: { clear() {} },
	statusContainer: { clear() {}, disposeChildren() {} },
	statusLine: { setCollabStatus() {}, invalidate() {}, resetActiveTime() {}, markActivityEnd() {} },
	ui: { requestRender() {} },
	eventController: {
		takeDisplaceableComponents: () => [],
		async handleEvent(event: AgentSessionEvent) {
			if (event.type === "message_end" && event.message.role === "user") events.push(String(event.message.content));
		},
	},
	resetObserverRegistry() {},
	syncRunningSubagentBadge() {},
	async renderInitialMessages() {
		await activationSeam("render");
	},
	async reloadTodos() {
		await activationSeam("todos");
	},
	showStatus() {},
	showError(message: string) {
		errors.push(message);
	},
	setHookStatus() {},
	updateEditorBorderColor() {},
	editor: { getText: () => "", setText() {} },
} as unknown as InteractiveModeContext;
const options: BoundCollabGuestOptions = {
	link,
	capability: "fixture-capability",
	expected: identity,
	label: "snapshot fixture",
	reconnectTimeoutMs: 5_000,
	async beforeSend() {
		persisted++;
	},
	onReceipt() {},
	onSnapshot() {
		snapshots.push(activeTitle);
	},
	onClosed() {
		closed++;
	},
};
const guest = new CollabGuestLink(context, unbound ? undefined : options);
async function until(predicate: () => boolean, label: string): Promise<void> {
	const deadline = performance.now() + 10_000;
	while (!predicate()) {
		if (transportError) throw transportError;
		assert.ok(performance.now() < deadline, `No progress: ${label}; errors=${JSON.stringify(errors)}`);
		await nextTurn();
	}
}
function welcome(title: string): CollabFrame {
	return {
		t: "welcome",
		proto: COLLAB_PROTO,
		header: {
			type: "session",
			version: 3,
			id: identity.sessionId,
			timestamp: "2026-01-01T00:00:00Z",
			cwd: process.cwd(),
			title,
		},
		state: { isStreaming: false, queuedMessageCount: 0, sessionName: title, cwd: process.cwd(), participants: [] },
		agents: [],
		entryCount: 0,
		managed: { version: MANAGED_COLLAB_VERSION, identity },
	};
}
function event(text: string): CollabFrame {
	return { t: "event", event: { type: "message_end", message: { role: "user", content: text, timestamp: 0 } } };
}
async function send(frame: CollabFrame): Promise<void> {
	const before = delivered.length;
	peers.at(-1)!.send(packEnvelope(0, await seal(key, frame)));
	await until(() => delivered.length > before, `delivery of ${frame.t}`);
}
async function disconnect(): Promise<void> {
	const before = closes;
	peers.at(-1)!.close(1012, "fixture reconnect");
	await until(() => closes > before, "guest observes disconnect");
}
async function reconnect(): Promise<void> {
	const before = peers.length;
	clock.advance(1_000);
	await until(
		() => peers.length > before && inbound.filter(frame => frame.t === "hello").length > before,
		"new encrypted hello",
	);
}
try {
	const join = guest.join(link);
	await until(() => inbound.some(frame => frame.t === "hello"), "initial encrypted hello");
	await send(welcome("initial"));
	await join;
	assert.equal(guest.connected, true);
	await disconnect();
	await reconnect();
	await send(welcome("interrupted"));
	await blocked.promise;
	assert.equal(paused, true);

	if (recovering) {
		// Both are decrypted and queued behind the held old finalizer. A fix that
		// only checks readiness but not queued frames reactivates stale-queued.
		await send(event("stale-event"));
		await send(welcome("stale-queued"));
	}
	await disconnect();
	assert.equal(guest.connected, false);

	if (recovering) {
		await reconnect();
		// These must remain ordered behind the old work, not be discarded with it.
		await send(welcome("current"));
		await send(event("current-event"));
		release.resolve();
		await until(() => events.includes("current-event"), "current snapshot and queued live event");
		assert.equal(guest.connected, true);
		assert.equal(guest.state?.sessionName, "current");
		assert.deepEqual(events, ["current-event"], "old-generation events must not reach native consumers");
		assert.deepEqual(activations, ["initial", "interrupted", "current"], "old queued welcome must not activate");
		if (!unbound) {
			assert.deepEqual(snapshots, ["initial", "current"]);
			await guest.submitRequest({ requestId: "after-reconnect", text: "current request", expected: identity });
			await until(() => inbound.some(frame => frame.t === "managed-prompt"), "current request on actual transport");
			assert.equal(persisted, 1);
			clock.advance(10_000);
			assert.equal(closed, 0, "successful current snapshot clears the reconnect budget");
		} else {
			guest.sendPrompt("unbound current request");
			await until(() => inbound.some(frame => frame.t === "prompt"), "unbound prompt on actual transport");
		}
	} else if (scenario === "deadline") {
		// First loss was at 0; its 5s budget must survive the reconnect at 1s
		// and another loss while that reconnect snapshot is activating.
		clock.advance(3_999);
		release.resolve();
		await nextTurn();
		assert.equal(closed, 0);
		clock.advance(1);
		assert.equal(closed, 1, "stale completion must not cancel the original reconnect deadline");
		assert.equal(guest.connected, false);
	} else {
		release.resolve();
		await nextTurn();
		await assert.rejects(
			guest.submitRequest({ requestId: "while-offline", text: "must not enter outbox", expected: identity }),
			/unavailable|disconnected/,
			"disconnected stale completion must not accept a managed request",
		);
		assert.equal(persisted, 0, "offline input must not reach beforeSend");
		assert.equal(guest.connected, false);
		assert.deepEqual(snapshots, ["initial"], "stale completion must not publish readiness");
	}
	assert.deepEqual(errors, []);
	process.stdout.write(`PASS ${scenario}\n`);
} finally {
	release.resolve();
	await guest.leave("fixture cleanup");
	server.stop(true);
	CollabSocket.prototype.connect = originalConnect;
	clock.restore();
}
