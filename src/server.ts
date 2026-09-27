import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";

import { config } from "./config.js";
import { RoomManager, type Client } from "./room.js";
import type {
  CommandTarget,
  LightAction,
  LightCommand,
} from "./types.js";

const app = express();
const rooms = new RoomManager();
const server = createServer(app);

let sequence = 0;

app.disable("x-powered-by");

app.use(
  cors({
    origin: config.allowedOrigins,
  }),
);

app.use(
  express.json({
    limit: "4kb",
  }),
);

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 4096,
});

// --------------------------------------------------
// Helpers
// --------------------------------------------------

function isValidIdentifier(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,32}$/.test(value);
}

function normalizeZone(value: string | null): string {
  if (!value) {
    return "main";
  }

  if (!isValidIdentifier(value)) {
    throw new Error("Invalid zone");
  }

  return value;
}

function normalizeRow(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }

  if (!isValidIdentifier(value)) {
    throw new Error("Invalid row");
  }

  return value;
}

function authorized(header?: string): boolean {
  if (!header?.startsWith("Bearer ")) {
    return false;
  }

  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(config.adminToken);

  return (
    provided.length === expected.length &&
    timingSafeEqual(provided, expected)
  );
}

function requireAdmin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!authorized(req.headers.authorization)) {
    return res.sendStatus(401);
  }

  next();
}

// --------------------------------------------------
// Public endpoints
// --------------------------------------------------

/**
 * Basic health check.
 *
 * Does not expose audience information.
 */
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
  });
});

/**
 * Public server clock.
 *
 * Used by clients for initial clock synchronization.
 */
app.get("/time", (_req, res) => {
  res.json({
    serverTime: Date.now(),
  });
});

// --------------------------------------------------
// Admin endpoints
// --------------------------------------------------

/**
 * Dynamic audience statistics.
 *
 * Example response:
 *
 * {
 *   "total": 5,
 *   "zones": {
 *     "A": {
 *       "total": 3,
 *       "rows": {
 *         "1": 1,
 *         "2": 2
 *       }
 *     },
 *     "B": {
 *       "total": 2,
 *       "rows": {
 *         "1": 2
 *       }
 *     }
 *   }
 * }
 */
app.get("/admin/stats", requireAdmin, (_req, res) => {
  return res.json(rooms.getStats());
});

/**
 * Send a light command.
 *
 * Supported targets:
 *
 * Global:
 * {
 *   "zone": "all"
 * }
 *
 * Zone:
 * {
 *   "zone": "A"
 * }
 *
 * Zone + row:
 * {
 *   "zone": "A",
 *   "row": "12"
 * }
 */
app.post("/admin/command", requireAdmin, (req, res) => {
  const body = req.body as {
    zone?: unknown;
    row?: unknown;
    action?: unknown;
    color?: unknown;
    duration?: unknown;
  };

  // ------------------------------------------------
  // Validate zone
  // ------------------------------------------------

  const zone =
    typeof body.zone === "string"
      ? body.zone.trim()
      : "all";

  if (
    zone !== "all" &&
    !isValidIdentifier(zone)
  ) {
    return res.status(400).json({
      error: "Invalid zone",
    });
  }

  // ------------------------------------------------
  // Validate row
  // ------------------------------------------------

  let row: string | undefined;

  if (body.row !== undefined) {
    if (
      typeof body.row !== "string" ||
      !isValidIdentifier(body.row)
    ) {
      return res.status(400).json({
        error: "Invalid row",
      });
    }

    row = body.row.trim();
  }

  // ------------------------------------------------
  // Validate action
  // ------------------------------------------------

  const validActions: LightAction[] = [
    "solid",
    "flash",
    "off",
  ];

  if (
    typeof body.action !== "string" ||
    !validActions.includes(
      body.action as LightAction,
    )
  ) {
    return res.status(400).json({
      error: "Invalid action",
    });
  }

  const action = body.action as LightAction;

  // ------------------------------------------------
  // Validate color
  // ------------------------------------------------

  const color =
    typeof body.color === "string"
      ? body.color.trim()
      : "#000000";

  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    return res.status(400).json({
      error: "Invalid color",
    });
  }

  // ------------------------------------------------
  // Validate duration
  // ------------------------------------------------

  const duration =
    typeof body.duration === "number"
      ? body.duration
      : 0;

  if (
    !Number.isFinite(duration) ||
    duration < 0 ||
    duration > 10_000
  ) {
    return res.status(400).json({
      error: "Invalid duration",
    });
  }

  // ------------------------------------------------
  // Build target
  // ------------------------------------------------

  const target: CommandTarget = {
    zone,
    ...(row !== undefined
      ? { row }
      : {}),
  };

  // ------------------------------------------------
  // Build command
  // ------------------------------------------------

  sequence++;

  const command: LightCommand = {
    type: "command",
    action,
    color,
    duration,
    timestamp: Date.now(),
    sequence,
  };

  // ------------------------------------------------
  // Broadcast
  // ------------------------------------------------

  const recipients = rooms.broadcast(
    target,
    command,
  );

  // ------------------------------------------------
  // Response
  // ------------------------------------------------

  return res.json({
    success: true,
    recipients,
    target,
    command,
  });
});

// --------------------------------------------------
// WebSocket upgrade handling
// --------------------------------------------------

server.on(
  "upgrade",
  (request, socket, head) => {
    try {
      const requestUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );

      // Only allow WebSocket connections on /ws.
      if (requestUrl.pathname !== "/ws") {
        socket.write(
          "HTTP/1.1 404 Not Found\r\n" +
            "Connection: close\r\n" +
            "\r\n",
        );

        socket.destroy();

        return;
      }

      // ------------------------------------------------
      // Validate Origin
      // ------------------------------------------------

      const origin = request.headers.origin;

      if (
        origin &&
        !config.allowedOrigins.includes(origin)
      ) {
        socket.write(
          "HTTP/1.1 403 Forbidden\r\n" +
            "Connection: close\r\n" +
            "\r\n",
        );

        socket.destroy();

        return;
      }

      // ------------------------------------------------
      // Read zone / row from query parameters
      // ------------------------------------------------

      let zone: string;
      let row: string | undefined;

      try {
        zone = normalizeZone(
          requestUrl.searchParams.get("zone"),
        );

        row = normalizeRow(
          requestUrl.searchParams.get("row"),
        );
      } catch {
        socket.write(
          "HTTP/1.1 400 Bad Request\r\n" +
            "Connection: close\r\n" +
            "\r\n",
        );

        socket.destroy();

        return;
      }

      // ------------------------------------------------
      // Complete WebSocket upgrade
      // ------------------------------------------------

      wss.handleUpgrade(
        request,
        socket,
        head,
        (webSocket) => {
          wss.emit(
            "connection",
            webSocket,
            {
              zone,
              row,
            },
          );
        },
      );
    } catch {
      socket.destroy();
    }
  },
);

// --------------------------------------------------
// WebSocket connection
// --------------------------------------------------

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

    // Add client to its dynamic zone.
    rooms.join(client);

    // Tell the client that it successfully joined.
    socket.send(
      JSON.stringify({
        type: "joined",
        zone: client.zone,
        row: client.row,
        serverTime: Date.now(),
      }),
    );

    // ------------------------------------------------
    // WebSocket heartbeat
    // ------------------------------------------------

    socket.on("pong", () => {
      client.alive = true;
    });

    // ------------------------------------------------
    // Client messages
    // ------------------------------------------------

    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(
          raw.toString(),
        );

        /**
         * Clients are only allowed to send ping.
         *
         * They cannot issue light commands.
         */
        if (
          message.type === "ping" &&
          Number.isFinite(message.timestamp)
        ) {
          socket.send(
            JSON.stringify({
              type: "pong",
              timestamp: message.timestamp,
              serverTime: Date.now(),
            }),
          );
        }
      } catch {
        socket.close(
          1003,
          "Invalid message",
        );
      }
    });

    // ------------------------------------------------
    // Cleanup
    // ------------------------------------------------

    socket.on("close", () => {
      rooms.leave(client);
    });

    socket.on("error", () => {
      rooms.leave(client);
    });
  },
);

// --------------------------------------------------
// Heartbeat
// --------------------------------------------------

const heartbeat = setInterval(() => {
  for (const client of rooms.getClients()) {
    /**
     * Client didn't answer the previous heartbeat.
     */
    if (!client.alive) {
      client.socket.terminate();
      rooms.leave(client);

      continue;
    }

    /**
     * Mark dead until the client responds with pong.
     */
    client.alive = false;

    client.socket.ping();
  }
}, 30_000);

// --------------------------------------------------
// Start server
// --------------------------------------------------

server.listen(
  config.port,
  "0.0.0.0",
  () => {
    console.log(
      `Realtime server on :${config.port}`,
    );
  },
);

// --------------------------------------------------
// Graceful shutdown
// --------------------------------------------------

function shutdown() {
  console.log(
    "Shutting down realtime server...",
  );

  clearInterval(heartbeat);

  wss.close();

  for (const client of rooms.getClients()) {
    client.socket.terminate();
  }

  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);