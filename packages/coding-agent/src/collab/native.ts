import * as path from "node:path";
import { sanitizeDisplayLine } from "@oh-my-pi/pi-tui/overlays/extensions/display-text";
import { postmortem, VERSION } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { InteractiveMode } from "../modes/interactive-mode";
import { createAgentSession, type CreateAgentSessionResult } from "../sdk";
import { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import type { BoundCollabGuestOptions } from "./bound-types";
import { CollabGuestLink } from "./guest";
import type { CollabHost } from "./host";
import {
	ManagedCollabCoordinator,
	type ManagedCollabAdmission,
	type ManagedCollabIdentity,
	type ManagedCollabPolicy,
} from "./managed";

export interface NativeCollabHandle {
	/** Real native UI, not a second renderer. The embedding owns its terminal/process. */
	mode: InteractiveMode;
	readonly stopping: boolean;
	/** Idempotent bounded cleanup. Timeout rejects: the supervisor must confirm process exit before replacement. */
	stop(timeoutMs?: number): Promise<void>;
	closed: Promise<void>;
}

export interface NativeManagedCollabHandle<Principal> extends NativeCollabHandle {
	/** Trusted local admission and every room share this coordinator and its pending work. */
	readonly coordinator: ManagedCollabCoordinator<Principal>;
	/** Generation is zero before the first room; publish a guest capability only after startRoom resolves. */
	readonly identity: ManagedCollabIdentity;
	readonly host: CollabHost | undefined;
	/** Coalesces concurrent starts. Relay failure leaves local admission and the native lifecycle alive. */
	startRoom(relay: string): Promise<CollabHost>;
}

function lifecycle(
	mode: InteractiveMode,
	initializing: Promise<void>,
	settle?: () => Promise<void>,
	release?: () => void,
): NativeCollabHandle {
	const closed = Promise.withResolvers<void>();
	let stopping: Promise<void> | undefined;
	const stop = (timeoutMs = 10_000): Promise<void> => {
		if (stopping) return stopping;
		const done = Promise.withResolvers<void>();
		stopping = done.promise;
		const deadline = Promise.withResolvers<never>();
		const timer = setTimeout(
			() => deadline.reject(new Error("Native collaboration stop timed out; process stop unconfirmed")),
			timeoutMs,
		);
		const cleanup = async (): Promise<void> => {
			try {
				await settle?.();
			} finally {
				// Initialization can acquire terminal/watchers after an await. Close only after it settles.
				try {
					await initializing;
				} catch {
					// The startup caller owns its original initialization error.
				}
				try {
					await mode.close();
				} finally {
					try {
						release?.();
					} finally {
						releaseSignals();
					}
				}
			}
		};
		void Promise.race([cleanup(), deadline.promise])
			.then(
				() => {
					closed.resolve();
					done.resolve();
				},
				error => {
					mode.stop();
					closed.reject(error);
					done.reject(error);
				},
			)
			.finally(() => {
				clearTimeout(timer);
			});
		return stopping;
	};
	const signal = (name: postmortem.ShutdownSignal): void => {
		process.exitCode = name === "SIGINT" ? 130 : name === "SIGTERM" ? 143 : 129;
		void stop().catch(() => {});
	};
	// Keep ownership through settlement, including repeated signals and stop timeouts.
	const releaseSignals = postmortem.claimSignalHandling(signal);
	closed.promise.catch(() => {});
	return {
		mode,
		stop,
		closed: closed.promise,
		get stopping() {
			return stopping !== undefined;
		},
	};
}

/** Initializes the native session without a relay. Room startup is an explicit, lazy operation. */
export async function startManagedCollabHost<Principal>(options: {
	session: CreateAgentSessionResult;
	binding: ManagedCollabAdmission["binding"];
	policy: ManagedCollabPolicy<Principal>;
}): Promise<NativeManagedCollabHandle<Principal>> {
	const result = options.session;
	const sessionId = result.session.sessionManager.getSessionId();
	const mode = new InteractiveMode(result.session, VERSION, undefined, result.setToolUIContext);
	const coordinator = new ManagedCollabCoordinator(result.session, options.binding, options.policy);
	mode.collabController.bindManaged(coordinator);
	const initializing = mode.init({ autoStartCollab: false, recentSessions: Promise.resolve([]) });
	const handle = lifecycle(mode, initializing, async () => {
		coordinator.withdraw();
		await mode.collabController.stop("managed host stopped");
		await result.session.abort();
		await coordinator.stop();
	});
	let opening: Promise<CollabHost> | undefined;
	const startRoom = (relay: string): Promise<CollabHost> => {
		if (handle.stopping) return Promise.reject(new Error("Native collaboration startup stopped"));
		if (opening) return opening;
		const existing = mode.collabController.host;
		if (existing) return Promise.resolve(existing);
		opening = mode.collabController
			.start({ access: "control", relay, managed: coordinator })
			.then(host => {
				if (handle.stopping) throw new Error("Native collaboration startup stopped");
				return host;
			})
			.finally(() => {
				opening = undefined;
			});
		return opening;
	};
	try {
		await initializing;
		if (handle.stopping) throw new Error("Native collaboration startup stopped");
		await mode.renderInitialMessages();
		if (handle.stopping) throw new Error("Native collaboration startup stopped");
		mode.collabController.startupComplete();
		return Object.defineProperties(Object.assign(handle, { coordinator, startRoom }), {
			host: { get: () => mode.collabController.host },
			identity: {
				get: (): ManagedCollabIdentity => ({
					...coordinator.binding,
					sessionId,
					instanceId: mode.collabController.instanceId,
					generation: mode.collabController.generation,
				}),
			},
		}) as NativeManagedCollabHandle<Principal>;
	} catch (error) {
		await handle.stop();
		throw error;
	}
}

/**
 * Run in a launcher-owned disposable process/profile/PTY. Secrets arrive in memory (or a
 * private pipe decoded by the launcher), never as CLI arguments. No local model/provider,
 * plugin, MCP, tool or composer-prediction discovery is enabled by this constructor.
 */
export async function startBoundCollabGuest(
	options: BoundCollabGuestOptions & {
		cwd: string;
		agentDir: string;
	},
): Promise<NativeCollabHandle & { guest: CollabGuestLink }> {
	// Capture the authenticated launcher contract before the first asynchronous startup step.
	options = Object.freeze({ ...options, expected: Object.freeze({ ...options.expected }) });
	const settings = Settings.initIsolated({
		cwd: options.cwd,
		agentDir: options.agentDir,
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
			includeWorkspaceTree: false,
		},
	});
	const authStorage = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(authStorage, path.join(options.agentDir, "models.yml"), {
		settings,
		replicaOnly: true,
	});
	const result = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settings,
		authStorage,
		modelRegistry,
		getApiKey: async () => undefined,
		sessionManager: SessionManager.create(options.cwd, path.join(options.agentDir, "replicas")),
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
	}).catch(error => {
		authStorage.close();
		throw error;
	});
	const mode = new InteractiveMode(result.session, VERSION, undefined, result.setToolUIContext);
	const initializing = mode.init({ autoStartCollab: false, recentSessions: Promise.resolve([]) });
	const handle = lifecycle(mode, initializing, undefined, () => authStorage.close());
	const guest = new CollabGuestLink(mode, {
		...options,
		label: sanitizeDisplayLine(options.label),
		onClosed: () => {
			void handle.stop().catch(() => {});
			options.onClosed();
		},
	});
	try {
		await initializing;
		if (handle.stopping) throw new Error("Bound collaboration startup stopped");
		mode.setHookStatus("bound-scope", sanitizeDisplayLine(options.label));
		await guest.join(options.link);
		if (handle.stopping) throw new Error("Bound collaboration startup stopped");
		return Object.assign(handle, { guest });
	} catch {
		await handle.stop();
		throw new Error("Bound collaboration startup failed (capability, binding or transport)");
	}
}
