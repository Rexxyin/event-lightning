import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";

import { config } from "./config.js";
import { RoomManager, type Client } from "./room.js";
import type { LightAction, LightCommand } from "./types.js";

const app = express();
const rooms = new RoomManager();
const server = createServer(app);

let sequence = 0;

app.disable("x-powered-by");
app.use(cors({ origin: config.allowedOrigins }));
app.use(express.json({ limit: "4kb" }));

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 4096,
});

function normalizeZone(value: string | null): string {
  if (!value) return "main";

  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(value)) {
    throw new Error("Invalid zone");
  }

  return value;
}

function authorized(header?: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;

  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(config.adminToken);

  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

// Health check, without exposing audience counts.
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Public clock endpoint for initial synchronization.
app.get("/time", (_req, res) => {
  res.json({ serverTime: Date.now() });
});

// Admin-only room statistics.
app.get("/admin/stats", (req, res) => {
  if (!authorized(req.headers.authorization)) {
    return res.sendStatus(401);
  }

  return res.json(rooms.getStats());
});

// Admin command endpoint.
app.post("/admin/command", (req, res) => {
  if (!authorized(req.headers.authorization)) {
    return res.sendStatus(401);
  }

  const { zone, action, color, duration } = req.body ?? {};

  if (
    typeof zone !== "string" ||
    (zone !== "all" && !/^[a-zA-Z0-9_-]{1,32}$/.test(zone))
  ) {
    return res.status(400).json({ error: "Invalid zone" });
  }

  if (!["solid", "flash", "off"].includes(action)) {
    return res.status(400).json({ error: "Invalid action" });
  }

  if (
    action !== "off" &&
    (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color))
  ) {
    return res.status(400).json({ error: "Invalid color" });
  }

  if (
    duration !== undefined &&
    (!Number.isInteger(duration) || duration < 50 || duration > 10000)
  ) {
    return res.status(400).json({
      error: "Duration must be 50–10000ms",
    });
  }

  const command: LightCommand = {
    type: "command",
    action: action as LightAction,
    color: action === "off" ? "#000000" : color,
    duration: duration ?? 250,
    timestamp: Date.now(),
    sequence: ++sequence,
  };

  const recipients = rooms.broadcast(zone, command);

  return res.json({
    success: true,
    recipients,
    command,
  });
});

// Join during the actual WebSocket handshake.
server.on("upgrade", (request, socket, head) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    const origin = request.headers.origin;

    if (origin && !config.allowedOrigins.includes(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    const zone = normalizeZone(url.searchParams.get("zone"));

    const row = url.searchParams.get("row") ?? undefined;

    if (row !== undefined && !/^[a-zA-Z0-9_-]{1,32}$/.test(row)) {
      throw new Error("Invalid row");
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, { zone, row });
    });
  } catch {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
  }
});

wss.on(
  "connection",
  (
    socket,
    metadata: {
      zone: string;
      row?: string;
    },
  ) => {
    const client: Client = {
      socket,
      zone: metadata.zone,
      row: metadata.row,
      alive: true,
    };

    rooms.join(client);

    socket.send(
      JSON.stringify({
        type: "joined",
        zone: client.zone,
        row: client.row,
        serverTime: Date.now(),
      }),
    );

    socket.on("pong", () => {
      client.alive = true;
    });

    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());

        // Audience sockets cannot issue light commands.
        if (message.type === "ping" && Number.isFinite(message.timestamp)) {
          socket.send(
            JSON.stringify({
              type: "pong",
              timestamp: message.timestamp,
              serverTime: Date.now(),
            }),
          );
        }
      } catch {
        socket.close(1003, "Invalid message");
      }
    });

    socket.on("close", () => rooms.leave(client));
    socket.on("error", () => rooms.leave(client));
  },
);

// Remove dead mobile connections.
const heartbeat = setInterval(() => {
  for (const client of rooms.getClients()) {
    if (!client.alive) {
      client.socket.terminate();
      rooms.leave(client);
      continue;
    }

    client.alive = false;
    client.socket.ping();
  }
}, 30000);

server.listen(config.port, "0.0.0.0", () => {
  console.log(`Realtime server on :${config.port}`);
});

function shutdown() {
  clearInterval(heartbeat);
  wss.close();
  for (const client of rooms.getClients()) {
    client.socket.terminate();
  }
  server.close();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
