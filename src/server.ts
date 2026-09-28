import 'dotenv/config';

import crypto from 'node:crypto';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import {
  WebSocket,
  WebSocketServer,
} from 'ws';

import { config } from './config.js';

import {
  rooms,
  type Client,
} from './room.js';

import {
  crowd,
} from './crowd.js';

import type {
  AudienceEvent,
  CommandTarget,
  LightAction,
  LightCommand,
} from './types.js';

/**
 * ---------------------------------------------------------
 * APP
 * ---------------------------------------------------------
 */

const app =
  express();

app.use(
  cors({
    origin(
      origin,
      callback,
    ) {
      /**
       * Allow non-browser clients such as curl/wscat.
       */
      if (!origin) {
        callback(
          null,
          true,
        );

        return;
      }

      if (
        config.allowedOrigins.includes(
          origin,
        )
      ) {
        callback(
          null,
          true,
        );

        return;
      }

      callback(
        new Error(
          'Origin not allowed',
        ),
      );
    },
  }),
);

app.use(
  express.json({
    limit: '4kb',
  }),
);

/**
 * ---------------------------------------------------------
 * HTTP SERVER
 * ---------------------------------------------------------
 */

const server =
  http.createServer(
    app,
  );

/**
 * ---------------------------------------------------------
 * WEBSOCKET SERVER
 * ---------------------------------------------------------
 */

const wss =
  new WebSocketServer({
    noServer: true,

    perMessageDeflate:
      false,

    maxPayload: 4096,
  });

/**
 * ---------------------------------------------------------
 * COMMAND SEQUENCE
 * ---------------------------------------------------------
 */

let commandSequence =
  0;

/**
 * ---------------------------------------------------------
 * HELPERS
 * ---------------------------------------------------------
 */

function normalizeZone(
  value: unknown,
): string | null {
  if (
    typeof value !==
    'string'
  ) {
    return null;
  }

  const zone =
    value.trim();

  if (
    zone.length === 0
  ) {
    return 'main';
  }

  if (
    zone === 'all'
  ) {
    return 'all';
  }

  if (
    !/^[a-zA-Z0-9_-]{1,32}$/.test(
      zone,
    )
  ) {
    return null;
  }

  return zone;
}

function normalizeRow(
  value: unknown,
): string | undefined {
  if (
    value ===
      undefined ||
    value === null ||
    value === ''
  ) {
    return undefined;
  }

  if (
    typeof value !==
    'string'
  ) {
    return undefined;
  }

  const row =
    value.trim();

  if (
    !/^[a-zA-Z0-9_-]{1,32}$/.test(
      row,
    )
  ) {
    return undefined;
  }

  return row;
}

function isValidColor(
  value: unknown,
): value is string {
  return (
    typeof value ===
      'string' &&
    /^#[0-9a-fA-F]{6}$/.test(
      value,
    )
  );
}

function isValidAction(
  value: unknown,
): value is LightAction {
  return (
    value === 'solid' ||
    value === 'flash' ||
    value === 'off'
  );
}

function isValidDuration(
  value: unknown,
): value is number {
  return (
    typeof value ===
      'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 10_000
  );
}

/**
 * Constant-time admin token comparison.
 */
function isValidAdminToken(
  token: string,
): boolean {
  const expected =
    Buffer.from(
      config.adminToken,
      'utf8',
    );

  const supplied =
    Buffer.from(
      token,
      'utf8',
    );

  if (
    expected.length !==
    supplied.length
  ) {
    return false;
  }

  return crypto.timingSafeEqual(
    expected,
    supplied,
  );
}

function requireAdmin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const header =
    req.headers.authorization;

  if (
    !header ||
    !header.startsWith(
      'Bearer ',
    )
  ) {
    res
      .status(401)
      .json({
        error:
          'Unauthorized',
      });

    return;
  }

  const token =
    header.slice(7);

  if (
    !isValidAdminToken(
      token,
    )
  ) {
    res
      .status(401)
      .json({
        error:
          'Unauthorized',
      });

    return;
  }

  next();
}

/**
 * ---------------------------------------------------------
 * AUDIENCE RATE LIMITER
 * ---------------------------------------------------------
 *
 * Token bucket per WebSocket connection.
 *
 * This allows:
 *
 * - repeated taps
 * - short bursts
 *
 * while preventing:
 *
 * - accidental event storms
 * - one connection generating millions of events
 *
 * It is NOT a one-vote-per-user system.
 */

class AudienceRateLimiter {
  private tokens: number;

  private lastRefill =
    Date.now();

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
  ) {
    this.tokens =
      burst;
  }

  consume(): boolean {
    const now =
      Date.now();

    const elapsed =
      (
        now -
        this.lastRefill
      ) / 1000;

    if (
      elapsed > 0
    ) {
      this.tokens =
        Math.min(
          this.burst,
          this.tokens +
            elapsed *
              this.ratePerSecond,
        );

      this.lastRefill =
        now;
    }

    if (
      this.tokens <
      1
    ) {
      return false;
    }

    this.tokens -=
      1;

    return true;
  }
}

/**
 ----------------------------------------------------------
 * HEALTH
 ----------------------------------------------------------
 */

app.get(
  '/health',
  (_req, res) => {
    res.json({
      status: 'ok',
    });
  },
);

/**
 * ---------------------------------------------------------
 * SERVER TIME
 * ---------------------------------------------------------
 */

app.get(
  '/time',
  (_req, res) => {
    res.json({
      serverTime:
        Date.now(),
    });
  },
);

/**
 * ---------------------------------------------------------
 * ADMIN STATS
 * ---------------------------------------------------------
 */

app.get(
  '/admin/stats',
  requireAdmin,
  (_req, res) => {
    res.json({
      status: 'ok',

      serverTime:
        Date.now(),

      rooms:
        rooms.getStats(),

      crowd:
        crowd.getStats(),
    });
  },
);

/**
 * ---------------------------------------------------------
 * ADMIN CROWD STATS
 * ---------------------------------------------------------
 *
 * This is useful for the admin dashboard because the
 * dashboard does not need to know anything about audience
 * WebSocket connections.
 */

app.get(
  '/admin/crowd',
  requireAdmin,
  (_req, res) => {
    res.json({
      status: 'ok',

      serverTime:
        Date.now(),

      crowd:
        crowd.getStats(),
    });
  },
);

/**
 * ---------------------------------------------------------
 * RESET CROWD INTERACTION
 * ---------------------------------------------------------
 *
 * Useful before a new audience interaction segment.
 *
 * Example:
 *
 * "Make some noise!"
 * → reset
 * → collect taps
 * → calculate energy
 * → trigger pattern
 */

app.post(
  '/admin/crowd/reset',
  requireAdmin,
  (_req, res) => {
    crowd.reset();

    res.json({
      success: true,

      crowd:
        crowd.getStats(),
    });
  },
);

/**
 * ---------------------------------------------------------
 * ADMIN LIGHT COMMAND
 * ---------------------------------------------------------
 */

app.post(
  '/admin/command',
  requireAdmin,
  (req, res) => {
    const body =
      req.body as {
        zone?: unknown;
        row?: unknown;
        action?: unknown;
        color?: unknown;
        duration?: unknown;
      };

    /**
     * Zone
     */
    const zone =
      normalizeZone(
        body.zone,
      );

    if (!zone) {
      res
        .status(400)
        .json({
          error:
            'Invalid zone',
        });

      return;
    }

    /**
     * Row
     */
    const row =
      normalizeRow(
        body.row,
      );

    if (
      body.row !==
        undefined &&
      body.row !==
        null &&
      body.row !==
        '' &&
      !row
    ) {
      res
        .status(400)
        .json({
          error:
            'Invalid row',
        });

      return;
    }

    /**
     * Action
     */
    if (
      !isValidAction(
        body.action,
      )
    ) {
      res
        .status(400)
        .json({
          error:
            'Invalid action',
        });

      return;
    }

    /**
     * Color
     */
    if (
      !isValidColor(
        body.color,
      )
    ) {
      res
        .status(400)
        .json({
          error:
            'Color must be #RRGGBB',
        });

      return;
    }

    /**
     * Duration
     */
    if (
      !isValidDuration(
        body.duration,
      )
    ) {
      res
        .status(400)
        .json({
          error:
            'Duration must be between 0 and 10000ms',
        });

      return;
    }

    const target: CommandTarget =
      {
        zone,

        ...(row
          ? { row }
          : {}),
      };

    const command:
      LightCommand =
      {
        type: 'command',

        action:
          body.action,

        color:
          body.color.toUpperCase(),

        duration:
          body.duration,

        timestamp:
          Date.now(),

        sequence:
          ++commandSequence,
      };

    const recipients =
      rooms.broadcast(
        target,
        command,
      );

    res.json({
      success: true,

      recipients,

      target,

      command,
    });
  },
);

/**
 * ---------------------------------------------------------
 * WEBSOCKET UPGRADE
 * ---------------------------------------------------------
 */

server.on(
  'upgrade',
  (
    request,
    socket,
    head,
  ) => {
    try {
      const origin =
        request.headers.origin;

      /**
       * Browser clients send Origin.
       *
       * CLI tools such as wscat generally do not.
       */
      if (
        origin &&
        !config.allowedOrigins.includes(
          origin,
        )
      ) {
        socket.write(
          'HTTP/1.1 403 Forbidden\r\n\r\n',
        );

        socket.destroy();

        return;
      }

      const url =
        new URL(
          request.url ??
            '/',
          `http://${request.headers.host}`,
        );

      if (
        url.pathname !==
        '/ws'
      ) {
        socket.write(
          'HTTP/1.1 404 Not Found\r\n\r\n',
        );

        socket.destroy();

        return;
      }

      /**
       * Audience room.
       *
       * These parameters are ONLY used for outgoing
       * spatial targeting.
       *
       * They are NOT used for incoming audience events.
       */
      const zone =
        normalizeZone(
          url.searchParams.get(
            'zone',
          ) ?? 'main',
        );

      if (
        !zone ||
        zone === 'all'
      ) {
        socket.write(
          'HTTP/1.1 400 Bad Request\r\n\r\n',
        );

        socket.destroy();

        return;
      }

      const row =
        normalizeRow(
          url.searchParams.get(
            'row',
          ),
        );

      wss.handleUpgrade(
        request,
        socket,
        head,
        ws => {
          wss.emit(
            'connection',
            ws,
            request,
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

/**
 * ---------------------------------------------------------
 * WEBSOCKET CONNECTION
 * ---------------------------------------------------------
 */

wss.on(
  'connection',
  (
    socket: WebSocket,
    _request: http.IncomingMessage,
    context: {
      zone: string;
      row?: string;
    },
  ) => {
    const client: Client =
      {
        socket,

        zone:
          context.zone,

        row:
          context.row,

        alive: true,
      };

    /**
     * Per-connection audience tap limiter.
     */
    const rateLimiter =
      new AudienceRateLimiter(
        config
          .audienceRateLimit
          .ratePerSecond,

        config
          .audienceRateLimit
          .burst,
      );

    rooms.join(
      client,
    );

    crowd.connectionOpened();

    /**
     * Initial connection acknowledgement.
     */
    socket.send(
      JSON.stringify({
        type: 'joined',

        zone:
          client.zone,

        ...(client.row
          ? {
              row:
                client.row,
            }
          : {}),

        serverTime:
          Date.now(),
      }),
    );

    /**
     * -------------------------------------------------------
     * MESSAGE HANDLER
     * -------------------------------------------------------
     */

socket.on(
  'message',
  data => {
    try {
      /**
       * ws RawData can be:
       * - Buffer
       * - ArrayBuffer
       * - Buffer[]
       *
       * Normalize all forms into a Buffer.
       */
      const payload: Buffer =
        Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(
                new Uint8Array(data),
              );

      /**
       * Protect the JSON parser from
       * unexpectedly large payloads.
       */
      if (
        payload.byteLength >
        4096
      ) {
        return;
      }

      const message =
        JSON.parse(
          payload.toString('utf8'),
        ) as unknown;

      if (
        !message ||
        typeof message !==
          'object'
      ) {
        return;
      }

      const event =
        message as Partial<AudienceEvent>;

      /**
       * PING
       */
      if (
        event.type ===
        'ping'
      ) {
        if (
          typeof event.timestamp !==
          'number'
        ) {
          return;
        }

        socket.send(
          JSON.stringify({
            type: 'pong',
            timestamp:
              event.timestamp,
            serverTime:
              Date.now(),
          }),
        );

        return;
      }

      /**
       * AUDIENCE TAP
       */
      if (
        event.type ===
        'tap'
      ) {
        if (
          !rateLimiter.consume()
        ) {
          return;
        }

        crowd.recordTap();

        return;
      }
    } catch {
      /**
       * Invalid client messages are
       * intentionally ignored.
       */
    }
  },
);

    /**
     * -------------------------------------------------------
     * HEARTBEAT
     * -------------------------------------------------------
     */

    socket.on(
      'pong',
      () => {
        client.alive =
          true;
      },
    );

    /**
     * -------------------------------------------------------
     * CLOSE
     * -------------------------------------------------------
     */

    socket.on(
      'close',
      () => {
        rooms.leave(
          client,
        );

        crowd.connectionClosed();
      },
    );

    socket.on(
      'error',
      () => {
        /**
         * close event performs cleanup.
         */
      },
    );
  },
);

/**
 * ---------------------------------------------------------
 * HEARTBEAT LOOP
 * ---------------------------------------------------------
 */

const heartbeat =
  setInterval(
    () => {
      for (
        const client of rooms.getClients()
      ) {
        if (
          client.alive ===
          false
        ) {
          rooms.leave(
            client,
          );

          crowd.connectionClosed();

          try {
            client.socket.terminate();
          } catch {
            // Ignore.
          }

          continue;
        }

        client.alive =
          false;

        try {
          client.socket.ping();
        } catch {
          rooms.leave(
            client,
          );

          crowd.connectionClosed();

          try {
            client.socket.terminate();
          } catch {
            // Ignore.
          }
        }
      }
    },
    30_000,
  );

/**
 * ---------------------------------------------------------
 * GRACEFUL SHUTDOWN
 * ---------------------------------------------------------
 */

function shutdown(
  signal: string,
): void {
  console.log(
    `[server] ${signal} received`,
  );

  clearInterval(
    heartbeat,
  );

  for (
    const client of rooms.getClients()
  ) {
    try {
      client.socket.close(
        1001,
        'Server shutting down',
      );
    } catch {
      // Ignore.
    }
  }

  server.close(
    () => {
      process.exit(
        0,
      );
    },
  );
}

process.on(
  'SIGTERM',
  () =>
    shutdown(
      'SIGTERM',
    ),
);

process.on(
  'SIGINT',
  () =>
    shutdown(
      'SIGINT',
    ),
);

/**
 * ---------------------------------------------------------
 * START
 * ---------------------------------------------------------
 */

server.listen(
  config.port,
  '0.0.0.0',
  () => {
    console.log(
      `[server] listening on :${config.port}`,
    );

    console.log(
      `[server] allowed origins: ${config.allowedOrigins.join(
        ', ',
      )}`,
    );

    console.log(
      `[server] audience tap rate: ${config.audienceRateLimit.ratePerSecond}/sec`,
    );
  },
);