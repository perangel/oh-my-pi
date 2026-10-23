import {
	COLLAB_PROMPT_MESSAGE_TYPE,
	isManagedCollabId,
	type ManagedCollabIdentity,
	type ManagedCollabReceipt,
	type ManagedCollabRequest,
	type ManagedCollabTurn,
} from "@oh-my-pi/pi-wire";
import type { AgentSession } from "../session/agent-session";

export * from "@oh-my-pi/pi-wire/managed-collab";

export interface ManagedCollabPolicy<Principal> {
	/** Stable authenticated principal key, including across reconnect. Never supplied by the peer. */
	principalId(principal: Principal): string;
	/** Authenticate an opaque credential. Never authorize by a guest's display name. */
	authenticate(capability: string, identity: ManagedCollabIdentity): Promise<Principal>;
	/** Called on EVERY submission, including same-ID retries, before admission. */
	lookup(
		principal: Principal,
		requestId: string,
		request?: ManagedCollabRequest,
	): Promise<ManagedCollabReceipt | undefined>;
	/** Persist the embedder's dispatch intent here. OMP, not this hook, invokes promptCustomMessage once. */
	admit(principal: Principal, request: ManagedCollabRequest): Promise<{ turnId: string } | { reject: string }>;
	cancel(principal: Principal, target: ManagedCollabTurn): Promise<boolean>;
	/** Completed native entries and settlement marker have been flushed before this callback. */
	settled(principal: Principal, receipt: ManagedCollabReceipt): Promise<void>;
	/** Admission is withdrawn on uncertainty. Report/reconcile; never retry inference from this callback. */
	failed?(principal: Principal, receipt: ManagedCollabReceipt): Promise<void>;
}

/** Type-erased transport seam. Unique peer tokens fence reused wire IDs across rooms. */
export interface ManagedCollabAdmission {
	readonly binding: Readonly<Pick<ManagedCollabIdentity, "binding" | "hostEpoch" | "childId">>;
	readonly activeTurn: ManagedCollabTurn | undefined;
	authenticate(peer: symbol, capability: string, identity: ManagedCollabIdentity): Promise<void>;
	forget(peer: symbol): void;
	lookup(peer: symbol, requestId: string): Promise<ManagedCollabReceipt>;
	submit(peer: symbol, request: ManagedCollabRequest, notify: (receipt: ManagedCollabReceipt) => void): Promise<void>;
	cancel(peer: symbol, target: ManagedCollabTurn): Promise<ManagedCollabReceipt>;
	withdraw(): void;
	/** Withdraw new work, then await the current prompt, flush and settlement callback. Does not abort it. */
	stop(): Promise<void>;
}

export function sameManagedIdentity(a: ManagedCollabIdentity, b: ManagedCollabIdentity): boolean {
	return (
		!!a &&
		!!b &&
		a.binding === b.binding &&
		a.hostEpoch === b.hostEpoch &&
		a.childId === b.childId &&
		a.sessionId === b.sessionId &&
		a.instanceId === b.instanceId &&
		a.generation === b.generation
	);
}

/** One coordinator per host lifetime. Reopening a journal NEVER replays dispatched work. */
export class ManagedCollabCoordinator<Principal> implements ManagedCollabAdmission {
	readonly binding: Readonly<Pick<ManagedCollabIdentity, "binding" | "hostEpoch" | "childId">>;
	#session: AgentSession;
	#policy: ManagedCollabPolicy<Principal>;
	#principals = new Map<symbol, Principal>();
	#authentication = new Map<symbol, symbol>();
	#payloads = new Map<string, string>();
	#seen = new Map<string, ManagedCollabReceipt>();
	#active: ManagedCollabTurn | undefined;
	#activeKey: string | undefined;
	#reserved = false;
	#closed = false;
	#pending = new Set<Promise<void>>();
	#journal: string | undefined;
	#failure: Error | undefined;
	#sessionId: string;

	constructor(
		session: AgentSession,
		binding: ManagedCollabAdmission["binding"],
		policy: ManagedCollabPolicy<Principal>,
	) {
		this.#session = session;
		this.binding = Object.freeze({ ...binding });
		this.#policy = policy;
		this.#journal = session.sessionManager.getSessionFile();
		this.#sessionId = session.sessionManager.getSessionId();
		if (!this.#journal) throw new Error("Managed collaboration requires a persistent native journal");
	}

	get activeTurn(): ManagedCollabTurn | undefined {
		return this.#active && { ...this.#active };
	}

	async authenticate(peer: symbol, capability: string, identity: ManagedCollabIdentity): Promise<void> {
		if (this.#closed) throw new Error("managed host stopped");
		const attempt = Symbol();
		this.#authentication.set(peer, attempt);
		const principal = await this.#policy.authenticate(capability, identity);
		if (this.#closed) throw new Error("managed host stopped");
		if (this.#authentication.get(peer) !== attempt) throw new Error("managed peer retired");
		this.#principals.set(peer, principal);
	}

	forget(peer: symbol): void {
		this.#authentication.delete(peer);
		this.#principals.delete(peer);
	}

	#principal(peer: symbol): Principal {
		if (!this.#principals.has(peer)) throw new Error("managed authentication required");
		return this.#principals.get(peer)!;
	}

	#key(principal: Principal, requestId: string): string {
		return JSON.stringify([this.#policy.principalId(principal), requestId]);
	}

	lookup(peer: symbol, requestId: string): Promise<ManagedCollabReceipt> {
		return this.lookupLocal(this.#principal(peer), requestId);
	}

	/** The embedder authenticates the principal; durable authorization remains in the policy. */
	async lookupLocal(principal: Principal, requestId: string): Promise<ManagedCollabReceipt> {
		const receipt = await this.#policy.lookup(principal, requestId);
		return receipt ?? this.#seen.get(this.#key(principal, requestId)) ?? { requestId, phase: "unknown" };
	}

	submit(peer: symbol, request: ManagedCollabRequest, notify: (receipt: ManagedCollabReceipt) => void): Promise<void> {
		return this.submitLocal(this.#principal(peer), request, notify);
	}

	/** Trusted local ingress. Uses the same admission, dedupe, cancellation and settlement as guests. */
	submitLocal(
		principal: Principal,
		request: ManagedCollabRequest,
		notify: (receipt: ManagedCollabReceipt) => void,
	): Promise<void> {
		const work = this.#submit(principal, request, notify);
		this.#pending.add(work);
		void work.finally(() => this.#pending.delete(work)).catch(() => {});
		return work;
	}

	async #submit(
		principal: Principal,
		request: ManagedCollabRequest,
		notify: (receipt: ManagedCollabReceipt) => void,
	): Promise<void> {
		const requestId = request.requestId;
		if (!isManagedCollabId(requestId) || typeof request.text !== "string") {
			throw new Error("invalid managed request");
		}
		const key = this.#key(principal, requestId);
		const existing = await this.#policy.lookup(principal, requestId, request);
		const hash = new Bun.CryptoHasher("sha256").update(request.text).digest("hex");
		const previousHash = this.#payloads.get(key);
		if (previousHash !== undefined && previousHash !== hash) {
			notify({ requestId, phase: "rejected", code: "request-conflict" });
			return;
		}
		if (existing) {
			notify(existing);
			return;
		}
		const seen = this.#seen.get(key);
		if (seen) {
			notify(seen);
			return;
		}
		const session = this.#session;
		if (
			this.#closed ||
			this.#reserved ||
			session.isStreaming ||
			session.hasAdmittedSubmission ||
			session.isSessionTransitioning ||
			session.queuedMessageCount
		) {
			notify({ requestId, phase: "rejected", code: this.#closed ? "stopped" : "busy" });
			return;
		}
		// Bound memory without evicting deduplication evidence. Roll over the host explicitly.
		if (this.#seen.size >= 10_000) {
			notify({ requestId, phase: "rejected", code: "capacity" });
			return;
		}
		this.#reserved = true;
		this.#payloads.set(key, hash);
		this.#seen.set(key, { requestId, phase: "unknown" });
		let receipt: ManagedCollabReceipt = { requestId, phase: "unknown" };
		try {
			this.#assertJournal();
			const decision = await this.#policy.admit(principal, request);
			if ("reject" in decision) {
				receipt = { requestId, phase: "rejected", code: decision.reject };
				notify(receipt);
				return;
			}
			if (this.#closed) {
				receipt = { requestId, phase: "rejected", code: "stopped" };
				notify(receipt);
				return;
			}
			if (!isManagedCollabId(decision.turnId)) throw new Error("invalid managed turn identity");
			this.#assertJournal();
			this.#active = { requestId, turnId: decision.turnId };
			this.#activeKey = key;
			receipt = { ...this.#active, phase: "running" };
			this.#seen.set(key, receipt);
			notify(receipt);
			const before = new Set(session.sessionManager.getEntries().map(entry => entry.id));
			let phase: ManagedCollabReceipt["phase"] = "completed";
			try {
				// No streamingBehavior: managed requests never steer or enter native queues.
				const dispatched = await session.promptCustomMessage({
					customType: COLLAB_PROMPT_MESSAGE_TYPE,
					content: request.text,
					display: true,
					attribution: "user",
					details: { managed: this.#active, expected: request.expected },
				});
				if (!dispatched) phase = "failed";
			} catch {
				phase = "failed";
			}
			const entries = session.sessionManager.getEntries().filter(entry => !before.has(entry.id));
			for (const entry of entries) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					if (entry.message.stopReason === "aborted") phase = "cancelled";
					else if (entry.message.stopReason === "error") phase = "failed";
				}
			}
			receipt = { ...this.#active, phase, entryIds: entries.map(entry => entry.id) };
			receipt.settlementEntryId = session.sessionManager.appendCustomEntry("managed-collab-settlement", receipt);
			await session.sessionManager.ensureOnDisk();
			await session.sessionManager.flush();
			if (session.sessionManager.getSessionFile() !== this.#journal) throw new Error("managed journal relocated");
			await this.#policy.settled(principal, receipt);
			notify(receipt);
		} catch {
			// A policy/storage failure is uncertainty, never permission to replay.
			this.#closed = true;
			this.#failure = new Error(
				"Managed collaboration settlement or admission failed; reconcile before replacement",
			);
			receipt = { requestId, turnId: this.#active?.turnId, phase: "unknown", code: "settlement-or-policy-failed" };
			this.#seen.set(key, receipt);
			try {
				await this.#policy.failed?.(principal, receipt);
			} catch {
				// Failure reporting cannot turn an uncertain dispatch into permission to replay.
			}
			notify(receipt);
		} finally {
			this.#seen.set(key, receipt);
			this.#active = undefined;
			this.#activeKey = undefined;
			this.#reserved = false;
		}
	}

	cancel(peer: symbol, target: ManagedCollabTurn): Promise<ManagedCollabReceipt> {
		return this.cancelLocal(this.#principal(peer), target);
	}

	/** The embedder authenticates the principal; policy.cancel still authorizes the exact active turn. */
	async cancelLocal(principal: Principal, target: ManagedCollabTurn): Promise<ManagedCollabReceipt> {
		const active = this.#active;
		const activeKey = this.#activeKey;
		if (!active || !activeKey || active.requestId !== target.requestId || active.turnId !== target.turnId) {
			return { requestId: target.requestId, phase: "rejected", code: "stale-turn" };
		}
		if (!(await this.#policy.cancel(principal, target))) return { ...target, phase: "rejected", code: "denied" };
		// Authorization can suspend. Never abort a successor or a settled turn.
		if (this.#active !== active) return { ...target, phase: "rejected", code: "stale-turn" };
		await this.#session.abort();
		return this.#seen.get(activeKey) ?? { ...target, phase: "unknown" };
	}

	#assertJournal(): void {
		if (
			this.#session.sessionManager.getSessionFile() !== this.#journal ||
			this.#session.sessionManager.getSessionId() !== this.#sessionId
		) {
			throw new Error("Managed native journal identity changed");
		}
	}

	withdraw(): void {
		this.#closed = true;
	}

	async stop(): Promise<void> {
		this.withdraw();
		await Promise.allSettled(this.#pending);
		await this.#session.sessionManager.flush();
		this.#assertJournal();
		if (this.#failure) throw this.#failure;
	}
}
