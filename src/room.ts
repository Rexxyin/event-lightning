import {
  WebSocket,
} from 'ws';

import type {
  CommandTarget,
  LightCommand,
} from './types.js';

export interface Client {
  socket: WebSocket;

  zone: string;

  row?: string;

  alive: boolean;
}

class RoomManager {
  private rooms =
    new Map<
      string,
      Set<Client>
    >();

  private clients =
    new Set<Client>();

  join(
    client: Client,
  ): void {
    this.clients.add(
      client,
    );

    let room =
      this.rooms.get(
        client.zone,
      );

    if (!room) {
      room =
        new Set<Client>();

      this.rooms.set(
        client.zone,
        room,
      );
    }

    room.add(client);
  }

  leave(
    client: Client,
  ): void {
    this.clients.delete(
      client,
    );

    const room =
      this.rooms.get(
        client.zone,
      );

    if (!room) {
      return;
    }

    room.delete(
      client,
    );

    if (
      room.size === 0
    ) {
      this.rooms.delete(
        client.zone,
      );
    }
  }

  broadcast(
    target: CommandTarget,
    command: LightCommand,
  ): number {
    const serialized =
      JSON.stringify(
        command,
      );

    let recipients = 0;

    /**
     * ALL means every connected audience phone.
     */
    if (
      target.zone === 'all'
    ) {
      for (
        const client of this.clients
      ) {
        if (
          this.send(
            client,
            serialized,
          )
        ) {
          recipients += 1;
        }
      }

      return recipients;
    }

    /**
     * Otherwise target a specific zone.
     */
    const room =
      this.rooms.get(
        target.zone,
      );

    if (!room) {
      return 0;
    }

    for (
      const client of room
    ) {
      /**
       * Optional row targeting.
       */
      if (
        target.row &&
        client.row !==
          target.row
      ) {
        continue;
      }

      if (
        this.send(
          client,
          serialized,
        )
      ) {
        recipients += 1;
      }
    }

    return recipients;
  }

  private send(
    client: Client,
    serialized: string,
  ): boolean {
    if (
      client.socket.readyState !==
      WebSocket.OPEN
    ) {
      return false;
    }

    /**
     * Basic backpressure protection.
     *
     * We do not want one slow mobile connection
     * to accumulate an unbounded send buffer.
     */
    if (
      client.socket.bufferedAmount >
      64 * 1024
    ) {
      return false;
    }

    try {
      client.socket.send(
        serialized,
      );

      return true;
    } catch {
      return false;
    }
  }

  getStats() {
    const zones: Record<
      string,
      {
        total: number;
        rows: Record<
          string,
          number
        >;
      }
    > = {};

    for (
      const [
        zone,
        clients,
      ] of this.rooms
    ) {
      const rows: Record<
        string,
        number
      > = {};

      for (
        const client of clients
      ) {
        if (
          client.row
        ) {
          rows[
            client.row
          ] =
            (
              rows[
                client.row
              ] ?? 0
            ) + 1;
        }
      }

      zones[zone] = {
        total:
          clients.size,
        rows,
      };
    }

    return {
      totalClients:
        this.clients.size,
      zones,
    };
  }

  getClients(): Set<Client> {
    return this.clients;
  }
}

export const rooms =
  new RoomManager();