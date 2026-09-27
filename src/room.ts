import WebSocket from "ws";
import type { LightCommand } from "./types.js";

export interface Client {
  socket: WebSocket;
  zone: string;
  row?: string;
  alive: boolean;
}

export class RoomManager {
  private rooms = new Map<string, Set<Client>>();
  private clients = new Set<Client>();

  join(client: Client) {
    let room = this.rooms.get(client.zone);

    if (!room) {
      room = new Set();
      this.rooms.set(client.zone, room);
    }

    room.add(client);
    this.clients.add(client);
  }

  leave(client: Client) {
    this.clients.delete(client);

    const room = this.rooms.get(client.zone);
    if (!room) return;

    room.delete(client);

    if (room.size === 0) {
      this.rooms.delete(client.zone);
    }
  }

  broadcast(zone: string | "all", command: LightCommand): number {
    const recipients = zone === "all" ? this.clients : this.rooms.get(zone);

    if (!recipients) return 0;

    // Serialize once per broadcast.
    const payload = JSON.stringify(command);
    let delivered = 0;

    for (const client of recipients) {
      if (client.socket.readyState !== WebSocket.OPEN) {
        continue;
      }

      // Avoid buffering unlimited data for slow devices.
      if (client.socket.bufferedAmount > 64 * 1024) {
        continue;
      }

      client.socket.send(payload);
      delivered++;
    }

    return delivered;
  }

  getStats() {
    return {
      total: this.clients.size,
      zones: Object.fromEntries(
        [...this.rooms].map(([name, members]) => [name, members.size]),
      ),
    };
  }

  getClients() {
    return this.clients;
  }
}
