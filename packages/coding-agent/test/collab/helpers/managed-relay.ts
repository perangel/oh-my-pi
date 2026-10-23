import type { ServerWebSocket } from "bun";
import { rewriteEnvelopePeer, unpackEnvelope } from "../../../src/collab/protocol";

interface Peer {
	room: string;
	role: string;
	id: number;
}
interface Room {
	host: ServerWebSocket<Peer>;
	guests: Map<number, ServerWebSocket<Peer>>;
	next: number;
}
export function startManagedTestRelay() {
	const rooms = new Map<string, Room>();
	const server = Bun.serve<Peer>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req, srv) {
			const url = new URL(req.url);
			if (srv.upgrade(req, { data: { room: url.pathname, role: url.searchParams.get("role") ?? "guest", id: 0 } }))
				return;
			return new Response(null, { status: 400 });
		},
		websocket: {
			maxPayloadLength: 16 * 1024 * 1024,
			open(ws) {
				const room = rooms.get(ws.data.room);
				if (ws.data.role === "host") {
					if (room) {
						ws.close(4009);
						return;
					}
					rooms.set(ws.data.room, { host: ws, guests: new Map(), next: 1 });
				} else {
					if (!room) {
						ws.close(4004);
						return;
					}
					ws.data.id = room.next++;
					room.guests.set(ws.data.id, ws);
					room.host.send(JSON.stringify({ t: "peer-joined", peer: ws.data.id }));
				}
			},
			message(ws, message) {
				if (typeof message === "string") return;
				const room = rooms.get(ws.data.room);
				if (!room) return;
				const bytes = new Uint8Array(message);
				if (ws === room.host) {
					const envelope = unpackEnvelope(bytes);
					if (!envelope) return;
					if (envelope.peerId) room.guests.get(envelope.peerId)?.send(bytes);
					else for (const guest of room.guests.values()) guest.send(bytes);
				} else {
					rewriteEnvelopePeer(bytes, ws.data.id);
					room.host.send(bytes);
				}
			},
			close(ws) {
				const room = rooms.get(ws.data.room);
				if (!room) return;
				if (room.host === ws) {
					rooms.delete(ws.data.room);
					for (const guest of room.guests.values()) guest.close(4001);
				} else {
					room.guests.delete(ws.data.id);
					room.host.send(JSON.stringify({ t: "peer-left", peer: ws.data.id }));
				}
			},
		},
	});
	if (import.meta.main) {
		process.on("SIGUSR1", () => {
			for (const room of rooms.values()) for (const guest of room.guests.values()) guest.close(1012);
		});
	}
	return server;
}

if (import.meta.main) {
	const server = startManagedTestRelay();
	process.stdout.write(`ws://127.0.0.1:${server.port}\n`);
	process.on("SIGTERM", () => {
		server.stop(true);
	});
	setTimeout(() => server.stop(true), 240_000).unref();
}
