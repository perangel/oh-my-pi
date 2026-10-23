import * as fs from "node:fs";
import * as path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	AuthStorage,
	ModelRegistry,
	SessionManager,
	Settings,
	InteractiveMode,
	type CreateAgentSessionResult,
	createAgentSession,
	startManagedCollabHost,
	startBoundCollabGuest,
	type ManagedCollabIdentity,
	type ManagedCollabReceipt,
	type NativeCollabHandle,
	type NativeManagedCollabHandle,
} from "@oh-my-pi/pi-coding-agent";
import { CollabSocket } from "../../../src/collab/relay-client";
import { importRoomKey } from "../../../src/collab/crypto";
import { COLLAB_PROTO, parseCollabLink, type CollabFrame } from "../../../src/collab/protocol";
import type { CollabHost } from "../../../src/collab/host";

const dir = process.env.FIXTURE_DIR!;
const role = process.env.FIXTURE_ROLE!;
const record = (value: object): void => fs.appendFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify(value)}\n`);
globalThis.fetch = Object.assign(
	async () => {
		record({ type: "blocked-fetch" });
		throw new Error("fixture HTTP disabled");
	},
	{ preconnect() {} },
);
let handle: NativeCollabHandle | undefined;
let settleHost: (() => Promise<void>) | undefined;
let managedNative: NativeManagedCollabHandle<string> | undefined;
let openRoom: ((relay: string, coalesce?: boolean) => Promise<void>) | undefined;
let timer: Timer | undefined;
const timeout = setTimeout(() => {
	process.exitCode = 2;
	void handle?.stop();
}, 90_000);
const receipts = new Map<string, ManagedCollabReceipt>();

const nativeInit = InteractiveMode.prototype.init;
InteractiveMode.prototype.init = async function (options) {
	if (process.env.FIXTURE_INIT_GATE === "1") {
		record({ type: "init-wait" });
		const until = Date.now() + 8000;
		while (!fs.existsSync(path.join(dir, "init-release")) && Date.now() < until) await Bun.sleep(30);
		if (!fs.existsSync(path.join(dir, "init-release"))) throw new Error("fixture initialization gate timed out");
	}
	await nativeInit.call(this, options);
	record({ type: "init-complete" });
};

// Ordinary SDK hosting, deliberately without the managed extension.
async function startUnboundHost(result: CreateAgentSessionResult): Promise<NativeCollabHandle & { host: CollabHost }> {
	const mode = new InteractiveMode(result.session, "fixture", undefined, result.setToolUIContext);
	const closed = Promise.withResolvers<void>();
	let stopping: Promise<void> | undefined;
	const stop = (): Promise<void> => {
		stopping ??= mode.close().then(() => closed.resolve());
		return stopping;
	};
	await mode.init({ autoStartCollab: false, recentSessions: Promise.resolve([]) });
	await mode.renderInitialMessages();
	mode.collabController.startupComplete();
	const host = await mode.collabController.start({ access: "control", relay: process.env.RELAY_URL! });
	return {
		mode,
		host,
		closed: closed.promise,
		stop,
		get stopping() {
			return stopping !== undefined;
		},
	};
}
// Deterministic transport fault for the completion-only boundary: all remaining
// frames still use real sealing/WebSockets. No synthetic renderer/session is used.
let suppressFinalUpdate = false;
const nativeSend = CollabSocket.prototype.send;
CollabSocket.prototype.send = function (frame, peer): void {
	if (suppressFinalUpdate && frame.t === "event" && frame.event.type === "message_update") {
		record({ type: "suppressed-final-update" });
		return;
	}
	nativeSend.call(this, frame, peer);
	if (frame.t === "event" && frame.event.type === "message_end") suppressFinalUpdate = false;
};
const input = role.endsWith("host")
	? undefined
	: (JSON.parse(fs.readFileSync(Number(process.env.FIXTURE_FD), "utf8")) as {
			link: string;
			capability: string;
			expected: ManagedCollabIdentity;
			version?: number;
		});
let raw: CollabSocket | undefined;
try {
	if (role.endsWith("host")) {
		const cwd = process.cwd();
		const agentDir = process.env.PI_CODING_AGENT_DIR!;
		const settings = await Settings.init({
			cwd,
			agentDir,
			inMemory: true,
			overrides: {
				"memory.backend": "off",
				"autolearn.enabled": false,
				"autolearn.autoContinue": false,
				"advisor.enabled": false,
				"collab.autoStart": "off",
				"startup.checkUpdate": false,
				"startup.setupWizard": false,
				"spelling.autocomplete": "off",
				"spelling.autocorrect": false,
				"spelling.typoDetection": false,
			},
		});
		const authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage, path.join(dir, "models.yml"), {
			settings,
			replicaOnly: true,
		});
		let calls = 0;
		modelRegistry.registerProvider("managed-fixture", {
			api: "managed-fixture",
			baseUrl: "http://127.0.0.1:1",
			apiKey: "fixture-not-a-credential",
			models: [
				{
					id: "deterministic",
					name: "Deterministic fixture",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32000,
					maxTokens: 1024,
				},
			],
			streamSimple(model, _context, options) {
				const stream = createAssistantMessageEventStream();
				const call = ++calls;
				record({ type: "inference", call });
				const message: AssistantMessage = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				void (async () => {
					stream.push({ type: "start", partial: message });
					const text = { type: "text" as const, text: "" };
					message.content.push(text);
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					for (const delta of [`NATIVE-${call} `, "streaming ", "complete."]) {
						await Bun.sleep(600);
						if (options?.signal?.aborted) {
							message.stopReason = "aborted";
							record({ type: "aborted", call });
							stream.push({ type: "error", reason: "aborted", error: message });
							return;
						}
						text.text += delta;
						stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
					}
					stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: message });
					const finalOnly = path.join(dir, "final-only");
					if (fs.existsSync(finalOnly)) {
						fs.unlinkSync(finalOnly);
						suppressFinalUpdate = true;
						record({ type: "waiting-final", call });
						await Bun.sleep(5000);
					}
					stream.push({ type: "done", reason: "stop", message });
				})();
				return stream;
			},
		});
		const manager = process.env.REOPEN_JOURNAL
			? await SessionManager.open(process.env.REOPEN_JOURNAL, undefined, undefined, { throwIfMissing: true })
			: SessionManager.create(cwd, path.join(dir, "sessions"));
		const result = await createAgentSession({
			cwd,
			agentDir,
			settings,
			authStorage,
			modelRegistry,
			model: modelRegistry.find("managed-fixture", "deterministic"),
			sessionManager: manager,
			getApiKey: async () => "fixture-not-a-credential",
			cacheWarming: false,
			spawns: "",
			restrictToolNames: true,
			toolNames: [],
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			hasUI: true,
		});
		const dispose = result.session.dispose.bind(result.session);
		result.session.dispose = async options => {
			record({ type: "dispose-enter" });
			await dispose(options);
		};
		const native =
			role === "unbound-host"
				? await startUnboundHost(result)
				: await startManagedCollabHost<string>({
						session: result,
						binding: { binding: "scope-v1", hostEpoch: `epoch-${process.pid}`, childId: dir },
						policy: {
							principalId(principal) {
								return principal;
							},
							async authenticate(capability) {
								if (capability !== "private-fixture-token") throw new Error("denied");
								return "owner";
							},
							async lookup(_principal, requestId) {
								record({ type: "lookup", requestId });
								return receipts.get(requestId);
							},
							async admit(_principal, request) {
								record({ type: "admit", requestId: request.requestId });
								if (request.text === "POLICY_REJECT") return { reject: "fixture-denied" };
								return { turnId: `turn-${request.requestId}` };
							},
							async cancel(_principal, target) {
								record({ type: "cancel", ...target });
								return true;
							},
							async settled(_principal, receipt) {
								if (fs.existsSync(path.join(dir, "settlement-block"))) {
									record({ type: "settlement-wait" });
									const until = Date.now() + 8000;
									while (!fs.existsSync(path.join(dir, "settlement-release")) && Date.now() < until)
										await Bun.sleep(30);
									if (!fs.existsSync(path.join(dir, "settlement-release")))
										throw new Error("fixture settlement gate timed out");
								}
								if (fs.existsSync(path.join(dir, "settlement-fail")))
									throw new Error("fixture settlement failure");
								const persisted = await Bun.file(manager.getSessionFile()!).text();
								if (!persisted.includes(receipt.settlementEntryId!))
									throw new Error("settlement was not flushed");
								receipts.set(receipt.requestId, receipt);
								record({ type: "settled", receipt });
							},
							async failed(_principal, receipt) {
								record({ type: "failure-receipt", receipt });
							},
						},
					});
		handle = native;
		if ("coordinator" in native) managedNative = native;
		settleHost = () => (managedNative ? managedNative.coordinator.stop() : native.host!.settle());
		openRoom = async (relay, coalesce = false) => {
			let room: CollabHost;
			if ("startRoom" in native) {
				const opening = native.startRoom(relay);
				if (coalesce) record({ type: "room-start-coalesced", same: opening === native.startRoom(relay) });
				room = await opening;
			} else room = native.host;
			fs.writeFileSync(
				path.join(dir, "capability.json"),
				JSON.stringify({
					link: room.link,
					capability: "private-fixture-token",
					expected: room.managedIdentity ?? {
						binding: "unbound",
						hostEpoch: "unbound",
						childId: dir,
						sessionId: manager.getSessionId(),
						instanceId: room.instanceId,
						generation: room.generation,
					},
				}),
				{ mode: 0o600 },
			);
			record({ type: "room-ready", identity: room.managedIdentity });
		};
		if (role !== "lazy-host") await openRoom(process.env.RELAY_URL!);
		record({
			type: "ready",
			sessionId: manager.getSessionId(),
			journal: manager.getSessionFile(),
			identity: managedNative?.identity,
		});
	} else if (role === "raw") {
		const parsed = parseCollabLink(input!.link);
		if ("error" in parsed) throw new Error("bad fixture capability");
		raw = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: await importRoomKey(parsed.key) });
		const socket = raw;
		socket.onOpen = () =>
			socket.send({
				t: "hello",
				proto: COLLAB_PROTO,
				name: "raw",
				writeToken: parsed.writeToken && Buffer.from(parsed.writeToken).toString("base64url"),
				managed: { version: input!.version ?? 1, expected: input!.expected, capability: input!.capability },
			});
		socket.onFrame = frame => {
			if (frame.t === "welcome") record({ type: "ready" });
			if (frame.t === "managed-receipt" || frame.t === "error") record(frame);
		};
		socket.connect();
	} else {
		const starting = startBoundCollabGuest({
			...input!,
			cwd: process.cwd(),
			agentDir: process.env.PI_CODING_AGENT_DIR!,
			label: "FACTORY fixture | TASK scoped | CONTROL",
			reconnectTimeoutMs: 2500,
			async beforeSend(request) {
				record({ type: "outbox", request });
				if (request.text === "UNSENT_DURING_RECONNECT" || request.text === "DELAYED_NATIVE_INPUT") {
					const until = Date.now() + 8000;
					while (!fs.existsSync(path.join(dir, "outbox-release")) && Date.now() < until) await Bun.sleep(30);
				}
			},
			onReceipt(receipt) {
				record({ type: "receipt", receipt });
			},
			onEvent(event, turn) {
				record({ type: "native-event", event: event.type, turn });
			},
			onSnapshot(identity) {
				record({ type: "snapshot-ready", identity });
			},
			onClosed() {
				record({ type: "closed" });
			},
		});
		if (role === "guest-mutating") input!.expected.binding = "mutated-after-launch";
		const native = await starting;
		handle = native;
		record({ type: "ready" });
	}
	timer = setInterval(async () => {
		if (handle)
			fs.writeFileSync(
				path.join(dir, "snapshot.json"),
				JSON.stringify({
					id: handle.mode.sessionManager.getSessionId(),
					entries: handle.mode.sessionManager.getEntries(),
					guest: !!handle.mode.collabGuest,
					connected: handle.mode.collabGuest?.connected,
					streaming: handle.mode.session.isStreaming,
					tools: handle.mode.session.getActiveToolNames(),
				}),
			);
		const file = path.join(dir, "command.json");
		if (fs.existsSync(file)) {
			const command = JSON.parse(fs.readFileSync(file, "utf8"));
			fs.unlinkSync(file);
			if (command.stop) await handle?.stop().catch(() => {});
			else if (command.stopTimeout && handle) {
				const stopping = handle.stop(command.stopTimeout);
				record({ type: "stop-idempotent", same: stopping === handle.stop() });
				await stopping.catch(() => {});
			} else if (raw) raw.send(command as CollabFrame);
			else if (command.room && openRoom) {
				try {
					await openRoom(command.room, command.coalesce);
				} catch {
					record({ type: "room-failed" });
				}
			} else if (command.roomStop && managedNative) {
				await managedNative.mode.collabController.stop("fixture room detach");
				record({ type: "room-stopped" });
			} else if (command.local && managedNative) {
				await managedNative.coordinator.submitLocal(
					"owner",
					{ ...command.local, expected: managedNative.identity },
					receipt => record({ type: "local-receipt", receipt }),
				);
			} else if (command.lookup && handle?.mode.collabGuest) handle.mode.collabGuest.lookupRequest(command.lookup);
			else if (command.resubmit && handle?.mode.collabGuest)
				await handle.mode.collabGuest.submitRequest(command.resubmit);
			else if (command.settle) {
				await settleHost?.();
				record({ type: "drained" });
			} else if (command.localProbe && handle) {
				try {
					await handle.mode.session.prompt("forbidden");
					record({ type: "local-dispatch" });
				} catch {
					record({ type: "local-denied" });
				}
			}
		}
	}, 80);
	if (handle) await handle.closed;
	else await Promise.withResolvers<void>().promise;
} catch (error) {
	record({ type: "failure", error: error instanceof Error ? error.message : "fixture failure" });
	process.exitCode = 1;
} finally {
	clearInterval(timer);
	clearTimeout(timeout);
	raw?.close();
	await handle?.stop().catch(() => {});
}
