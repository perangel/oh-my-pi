import assert from "node:assert/strict";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { importRoomKey } from "../../src/collab/crypto";
import { CollabHost } from "../../src/collab/host";
import {
	ManagedCollabCoordinator,
	type ManagedCollabIdentity,
	type ManagedCollabPolicy,
	type ManagedCollabReceipt,
} from "../../src/collab/managed";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "../../src/collab/protocol";
import { CollabSocket } from "../../src/collab/relay-client";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { InteractiveModeContext } from "../../src/modes/types";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { startManagedTestRelay } from "./helpers/managed-relay";

const root = process.env.FIXTURE_DIR!;

function inbox<T>() {
	const values: T[] = [];
	const waiters: Array<(value: T) => void> = [];
	return {
		push(value: T): void {
			const waiter = waiters.shift();
			if (waiter) waiter(value);
			else values.push(value);
		},
		next(): Promise<T> {
			if (values.length) return Promise.resolve(values.shift()!);
			const pending = Promise.withResolvers<T>();
			waiters.push(pending.resolve);
			return pending.promise;
		},
	};
}

function providerTurn() {
	const started = Promise.withResolvers<AbortSignal>();
	const released = Promise.withResolvers<void>();
	const handler: MockHandler = async (_context, options) => {
		const signal = options?.signal;
		assert.ok(signal, "native provider must receive its cancellation signal");
		const onAbort = () => released.resolve();
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) released.resolve();
		started.resolve(signal);
		try {
			await released.promise;
			return { content: ["native provider response"], stopReason: signal.aborted ? "aborted" : "stop" };
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	};
	return { handler, started: started.promise, finish: () => released.resolve() };
}

async function createFixture(
	responses: MockHandler[],
	hooks: Partial<Pick<ManagedCollabPolicy<string>, "cancel" | "settled">> = {},
) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	assert.ok(model);
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "fixture-not-a-credential");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"todo.enabled": false,
		"memory.backend": "off",
		"autolearn.enabled": false,
		"autolearn.autoContinue": false,
		"advisor.enabled": false,
	});
	const provider = createMockModel({ responses });
	const agent = new Agent({
		getApiKey: () => "fixture-not-a-credential",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
		streamFn: provider.stream,
	});
	const manager = SessionManager.create(root, path.join(root, "sessions"));
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: new ModelRegistry(auth, path.join(root, "models.yml"), { settings, replicaOnly: true }),
	});
	const binding = { binding: "protocol-regression", hostEpoch: "epoch", childId: "child" };
	const expected: ManagedCollabIdentity = {
		...binding,
		sessionId: manager.getSessionId(),
		instanceId: "fixture",
		generation: 1,
	};
	let authentications = 0;
	const coordinator = new ManagedCollabCoordinator(session, binding, {
		principalId: principal => principal,
		async authenticate(capability) {
			authentications++;
			if (capability !== "A" && capability !== "B") throw new Error("invalid capability");
			return capability;
		},
		async lookup() {
			return undefined;
		},
		async admit(principal, request) {
			return { turnId: `turn-${principal}-${request.requestId}` };
		},
		cancel: hooks.cancel ?? (async () => true),
		settled: hooks.settled ?? (async () => {}),
	});
	return {
		session,
		manager,
		settings,
		coordinator,
		expected,
		provider,
		get authentications() {
			return authentications;
		},
		async close() {
			await coordinator.stop();
			await session.dispose();
			auth.close();
		},
	};
}

async function crossPrincipalCancel(): Promise<void> {
	const turnA = providerTurn();
	const settlementEntered = Promise.withResolvers<ManagedCollabReceipt>();
	const releaseSettlement = Promise.withResolvers<void>();
	let allowCancel = false;
	const fixture = await createFixture([{ content: ["B's first response"] }, turnA.handler], {
		async cancel(principal) {
			assert.equal(principal, "B");
			return allowCancel;
		},
		async settled(principal, receipt) {
			if (principal !== "A") return;
			settlementEntered.resolve(receipt);
			await releaseSettlement.promise;
		},
	});
	const { coordinator, expected, manager } = fixture;
	const receiptsA: ManagedCollabReceipt[] = [];
	const receiptsB: ManagedCollabReceipt[] = [];
	let pendingA: Promise<void> | undefined;
	const peerA = Symbol("A");
	const peerB = Symbol("B");
	const reconnectedA = Symbol("A reconnected");
	const reconnectedB = Symbol("B reconnected");
	try {
		await coordinator.authenticate(peerA, "A", expected);
		await coordinator.authenticate(peerB, "B", expected);
		await coordinator.submit(peerB, { requestId: "x", text: "B's independently valid x", expected }, receipt =>
			receiptsB.push(receipt),
		);
		const completedB = await coordinator.lookup(peerB, "x");
		assert.equal(completedB.phase, "completed");
		assert.equal(completedB.turnId, "turn-B-x");
		assert.deepEqual(await coordinator.lookupLocal("A", "x"), { requestId: "x", phase: "unknown" });
		pendingA = coordinator.submitLocal(
			"A",
			{ requestId: "x", text: "A's independently valid x", expected },
			receipt => receiptsA.push(receipt),
		);
		const signalA = await turnA.started;
		const target = { requestId: "x", turnId: "turn-A-x" };
		assert.deepEqual(await coordinator.cancel(peerB, target), { ...target, phase: "rejected", code: "denied" });
		assert.equal(signalA.aborted, false, "policy denial must not abort A");
		allowCancel = true;
		const cancellation = await coordinator.cancel(peerB, target);
		assert.equal(signalA.aborted, true, "authorized B must abort A's actual native provider");
		// Cancellation does not imply the embedder's settlement callback has finished.
		// The pending response still MUST refer to A, never B's same-ID receipt.
		assert.equal(cancellation.requestId, target.requestId);
		assert.equal(cancellation.turnId, target.turnId);
		assert.equal(cancellation.phase, "running");
		const settledA = await settlementEntered.promise;
		assert.equal(settledA.phase, "cancelled");
		assert.equal(settledA.turnId, target.turnId);
		assert.ok(settledA.settlementEntryId);
		assert.ok(manager.getEntries().some(entry => entry.id === settledA.settlementEntryId));
		releaseSettlement.resolve();
		await pendingA;
		coordinator.forget(peerA);
		coordinator.forget(peerB);
		await coordinator.authenticate(reconnectedA, "A", expected);
		await coordinator.authenticate(reconnectedB, "B", expected);
		assert.deepEqual(await coordinator.lookup(reconnectedA, "x"), settledA);
		assert.deepEqual(await coordinator.lookup(reconnectedB, "x"), completedB);
		await coordinator.submit(reconnectedA, { requestId: "x", text: "A's independently valid x", expected }, receipt =>
			receiptsA.push(receipt),
		);
		await coordinator.submitLocal("B", { requestId: "x", text: "B's independently valid x", expected }, receipt =>
			receiptsB.push(receipt),
		);
		assert.equal(fixture.provider.calls.length, 2, "same-ID retries must not replay either principal's inference");
		assert.deepEqual(
			receiptsA.map(receipt => receipt.phase),
			["running", "cancelled", "cancelled"],
		);
		assert.deepEqual(
			receiptsB.map(receipt => receipt.phase),
			["running", "completed", "completed"],
		);
	} finally {
		turnA.finish();
		releaseSettlement.resolve();
		await pendingA;
		await fixture.close();
	}
}

async function lateCancelAuthorization(): Promise<void> {
	const turnA = providerTurn();
	const turnB = providerTurn();
	const authorizationEntered = Promise.withResolvers<void>();
	const releaseAuthorization = Promise.withResolvers<boolean>();
	const fixture = await createFixture([turnA.handler, turnB.handler], {
		async cancel() {
			authorizationEntered.resolve();
			return releaseAuthorization.promise;
		},
	});
	const { coordinator, expected } = fixture;
	const receipts: ManagedCollabReceipt[] = [];
	let pendingA: Promise<void> | undefined;
	let pendingB: Promise<void> | undefined;
	const peerA = Symbol("A");
	const peerB = Symbol("B");
	try {
		await coordinator.authenticate(peerA, "A", expected);
		await coordinator.authenticate(peerB, "B", expected);
		pendingA = coordinator.submit(
			peerA,
			{ requestId: "x", text: "A finishes during authorization", expected },
			receipt => receipts.push(receipt),
		);
		const signalA = await turnA.started;
		const target = { requestId: "x", turnId: "turn-A-x" };
		const cancellation = coordinator.cancelLocal("B", target);
		await authorizationEntered.promise;
		turnA.finish();
		await pendingA;
		assert.equal(signalA.aborted, false);
		pendingB = coordinator.submit(peerB, { requestId: "x", text: "B's independent successor", expected }, receipt =>
			receipts.push(receipt),
		);
		const signalB = await turnB.started;
		releaseAuthorization.resolve(true);
		assert.deepEqual(await cancellation, { ...target, phase: "rejected", code: "stale-turn" });
		assert.equal(signalB.aborted, false, "late authorization must not abort B's same-request-ID successor");
		turnB.finish();
		await pendingB;
		assert.equal((await coordinator.lookup(peerA, "x")).phase, "completed");
		assert.equal((await coordinator.lookupLocal("B", "x")).phase, "completed");
		assert.deepEqual(
			receipts.map(receipt => [receipt.turnId, receipt.phase]),
			[
				["turn-A-x", "running"],
				["turn-A-x", "completed"],
				["turn-B-x", "running"],
				["turn-B-x", "completed"],
			],
		);
	} finally {
		releaseAuthorization.resolve(false);
		turnA.finish();
		turnB.finish();
		await Promise.all([pendingA, pendingB]);
		await fixture.close();
	}
}

async function malformedFrame(managed: boolean): Promise<void> {
	const relay = startManagedTestRelay();
	const relayUrl = `ws://127.0.0.1:${relay.port}`;
	const fixture = await createFixture([{ content: ["unbound native response"] }]);
	const context = {
		settings: fixture.settings,
		session: fixture.session,
		sessionManager: fixture.manager,
		statusLine: {
			setCollabStatus() {},
			invalidate() {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 32000 }),
		},
		ui: { requestRender() {} },
		showStatus() {},
	} as unknown as InteractiveModeContext;
	const host = new CollabHost(context, { managed: managed ? fixture.coordinator : undefined });
	const sockets: CollabSocket[] = [];
	async function connect(link: string) {
		const parsed = parseCollabLink(link);
		assert.ok(!("error" in parsed));
		const key = await importRoomKey(parsed.key);
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, key, role: "guest" });
		sockets.push(socket);
		const frames = inbox<CollabFrame>();
		const connected = Promise.withResolvers<void>();
		socket.onOpen = () => connected.resolve();
		socket.onFrame = frame => frames.push(frame);
		socket.connect();
		await connected.promise;
		return {
			socket,
			writeToken: parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined,
			async next(type: CollabFrame["t"]): Promise<CollabFrame> {
				for (;;) {
					const frame = await frames.next();
					if (frame.t === type) return frame;
				}
			},
		};
	}
	try {
		await host.start(relayUrl);
		const attacker = await connect(host.viewLink);
		// Real JSON serialization, AES-GCM sealing, envelope routing and host
		// decryption, without a write token or any capability authentication.
		attacker.socket.send(null as unknown as CollabFrame);
		attacker.socket.send({ t: "hello", name: "unauthenticated", proto: COLLAB_PROTO });
		await attacker.next(managed ? "error" : "welcome");
		assert.equal(fixture.authentications, 0);
		if (managed) assert.equal(host.participants.length, 1);
		const writer = await connect(host.link);
		writer.socket.send({
			t: "hello",
			name: "authenticated",
			proto: COLLAB_PROTO,
			writeToken: writer.writeToken,
			...(managed ? { managed: { version: 1, capability: "A", expected: host.managedIdentity! } } : {}),
		});
		await writer.next("welcome");
		if (managed) {
			writer.socket.send({ t: "managed-lookup", requestId: "after-null", expected: host.managedIdentity! });
			const response = await writer.next("managed-receipt");
			assert.equal(response.t, "managed-receipt");
			assert.deepEqual(response.receipt, { requestId: "after-null", phase: "unknown" });
			assert.equal(fixture.authentications, 1);
			assert.equal(fixture.provider.calls.length, 0);
		} else {
			const ended = Promise.withResolvers<void>();
			const unsubscribe = fixture.session.subscribe(event => {
				if (event.type === "agent_end") ended.resolve();
			});
			try {
				writer.socket.send({ t: "prompt", text: "ordinary native prompt after null" });
				await ended.promise;
				await fixture.session.waitForIdle();
				assert.equal(fixture.provider.calls.length, 1);
				assert.ok(
					fixture.manager
						.getEntries()
						.some(
							entry =>
								entry.type === "message" &&
								entry.message.role === "assistant" &&
								entry.message.stopReason === "stop",
						),
				);
			} finally {
				unsubscribe();
			}
		}
	} finally {
		for (const socket of sockets) socket.close();
		await host.stop("protocol regression complete");
		await fixture.close();
		relay.stop(true);
	}
}

const scenario = process.argv[2];
if (scenario === "managed-null") await malformedFrame(true);
else if (scenario === "unbound-null") await malformedFrame(false);
else if (scenario === "cross-principal-cancel") await crossPrincipalCancel();
else if (scenario === "late-cancel-authorization") await lateCancelAuthorization();
else throw new Error(`Unknown protocol regression scenario: ${scenario}`);
process.stdout.write(`PASS ${scenario}\n`);
