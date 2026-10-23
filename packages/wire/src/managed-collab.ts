/** Opt-in extension to collab v3. Ordinary peers do not negotiate this extension. */
export const MANAGED_COLLAB_VERSION = 1;

/** Bound control identifiers are opaque, non-empty strings with a bounded wire size. */
export function isManagedCollabId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256;
}

/** Opaque embedder binding plus native room identity. Generation is only instance-local. */
export interface ManagedCollabIdentity {
	binding: string;
	hostEpoch: string;
	childId: string;
	sessionId: string;
	instanceId: string;
	generation: number;
}

export interface ManagedCollabHello {
	version: number;
	expected: ManagedCollabIdentity;
	/** Opaque credential; memory/private-pipe only, never a display name. */
	capability: string;
}

export interface ManagedCollabRequest {
	requestId: string;
	expected: ManagedCollabIdentity;
	text: string;
}

export interface ManagedCollabTurn {
	requestId: string;
	turnId: string;
}

export interface ManagedCollabReceipt {
	requestId: string;
	turnId?: string;
	phase: "running" | "completed" | "cancelled" | "failed" | "rejected" | "unknown";
	code?: string;
	/** Canonical native journal IDs, not a second transcript. */
	entryIds?: string[];
	settlementEntryId?: string;
}

export type ManagedCollabGuestFrame =
	| { t: "managed-prompt"; request: ManagedCollabRequest }
	| { t: "managed-lookup"; requestId: string; expected: ManagedCollabIdentity }
	| { t: "managed-cancel"; requestId: string; turnId: string; expected: ManagedCollabIdentity };

export type ManagedCollabHostFrame = { t: "managed-receipt"; receipt: ManagedCollabReceipt };
