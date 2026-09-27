import WebSocket from 'ws';
import type { LightCommand } from './types.js';

export interface Client {
  socket: WebSocket;
  zone: string;
  row?: string;
  alive: boolean;
}

export interface BroadcastTarget {
  zone: string | 'all';
  row?: string;
}

export class RoomManager {
  /**
   * Zone -> clients
   *
   * Example:
   *
   * A -> [phone1, phone2, phone3]
   * B -> [phone4, phone5]
   */
  private rooms = new Map<string, Set<Client>>();

  /**
   * All connected clients.
   */
  private clients = new Set<Client>();

  /**
   * Add a client to the appropriate zone.
   */
  join(client: Client) {
    let room = this.rooms.get(client.zone);

    if (!room) {
      room = new Set<Client>();
      this.rooms.set(client.zone, room);
    }

    room.add(client);
    this.clients.add(client);
  }

  /**
   * Remove a client from its zone and global client set.
   */
  leave(client: Client) {
    this.clients.delete(client);

    const room = this.rooms.get(client.zone);

    if (!room) {
      return;
    }

    room.delete(client);

    // Remove empty zones.
    if (room.size === 0) {
      this.rooms.delete(client.zone);
    }
  }

  /**
   * Broadcast a command.
   *
   * Supported targets:
   *
   * { zone: 'all' }
   * { zone: 'A' }
   * { zone: 'A', row: '12' }
   */
  broadcast(
    target: BroadcastTarget,
    command: LightCommand
  ): number {
    const payload = JSON.stringify(command);

    let recipients: Iterable<Client>;

    // Global broadcast.
    if (target.zone === 'all') {
      recipients = this.clients;
    } else {
      // Zone broadcast.
      const room = this.rooms.get(target.zone);

      if (!room) {
        return 0;
      }

      recipients = room;
    }

    let delivered = 0;

    for (const client of recipients) {
      // Row targeting.
      //
      // If a row was specified, only deliver to clients
      // belonging to that row.
      if (
        target.row !== undefined &&
        client.row !== target.row
      ) {
        continue;
      }

      // Don't send to closed/non-open sockets.
      if (client.socket.readyState !== WebSocket.OPEN) {
        continue;
      }

      // Protect the server from endlessly buffering data
      // for a slow client.
      if (client.socket.bufferedAmount > 64 * 1024) {
        continue;
      }

      client.socket.send(payload);

      delivered++;
    }

    return delivered;
  }

  /**
   * Return dynamic audience information.
   *
   * Example:
   *
   * {
   *   total: 6,
   *   zones: {
   *     A: {
   *       total: 3,
   *       rows: {
   *         '1': 1,
   *         '2': 2
   *       }
   *     },
   *     B: {
   *       total: 2,
   *       rows: {
   *         '1': 2
   *       }
   *     }
   *   }
   * }
   */
  getStats() {
    const zones: Record<
      string,
      {
        total: number;
        rows: Record<string, number>;
      }
    > = {};

    for (const [zone, members] of this.rooms) {
      const rows: Record<string, number> = {};

      for (const client of members) {
        const row = client.row ?? 'unassigned';

        rows[row] = (rows[row] ?? 0) + 1;
      }

      zones[zone] = {
        total: members.size,
        rows,
      };
    }

    return {
      total: this.clients.size,
      zones,
    };
  }

  /**
   * Useful for heartbeat/shutdown logic.
   */
  getClients() {
    return this.clients;
  }
}