import type {
	ManagedCollabIdentity,
	ManagedCollabReceipt,
	ManagedCollabRequest,
	ManagedCollabTurn,
} from "@oh-my-pi/pi-wire";
import type { AgentSessionEvent } from "../session/agent-session";

export interface BoundCollabGuestOptions {
	/** Private in-memory join capability. Do not put this object on argv or in logs. */
	link: string;
	capability: string;
	expected: ManagedCollabIdentity;
	/** Fixed, non-secret scope chrome supplied by the authenticated launcher. */
	label: string;
	/** Persist an outbox envelope before transport dispatch. Throw to leave it unsent. */
	beforeSend(request: ManagedCollabRequest): Promise<void>;
	/** Total resnapshot/reconnect budget after connection loss; default 30 seconds. */
	reconnectTimeoutMs?: number;
	onReceipt(receipt: ManagedCollabReceipt): void;
	/** Live native events only; reconnect uses the native snapshot, never token replay. */
	onEvent?(event: AgentSessionEvent, turn: ManagedCollabTurn | undefined): void;
	/** Native replica is synchronized after initial join or reconnect. No requests are replayed. */
	onSnapshot?(identity: Readonly<ManagedCollabIdentity>): void;
	/** Called once after terminal failure/leave. Local ownership is never restored. */
	onClosed(): void;
}
