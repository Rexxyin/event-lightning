export type LightAction =
  | 'solid'
  | 'flash'
  | 'off';

export type PatternType =
  | 'pulse'
  | 'wave'
  | 'ripple'
  | 'chase'
  | 'spark'
  | 'comet'
  | 'finale';

export interface CommandTarget {
  zone: string;
  row?: string;
}

export interface PatternConfig {
  type: PatternType;
  intensity: number;
  seed: number;
}

export interface LightCommand {
  type: 'command';

  action: LightAction;

  color: string;

  duration: number;

  timestamp: number;

  sequence: number;

  pattern?: PatternConfig;
}

/**
 * ---------------------------------------------------------
 * AUDIENCE → SERVER
 * ---------------------------------------------------------
 *
 * These events intentionally contain NO:
 * - zone
 * - row
 * - seat
 * - position
 *
 * They are aggregate audience interactions.
 */
export type AudienceEvent =
  | {
      type: 'tap';
      timestamp?: number;
    }
  | {
      type: 'ping';
      timestamp: number;
    };

/**
 * ---------------------------------------------------------
 * SERVER → AUDIENCE
 * ---------------------------------------------------------
 */

export interface JoinedMessage {
  type: 'joined';

  zone: string;

  row?: string;

  serverTime: number;
}

export interface PongMessage {
  type: 'pong';

  timestamp: number;

  serverTime: number;
}

export type ServerMessage =
  | JoinedMessage
  | PongMessage
  | LightCommand;

/**
 * ---------------------------------------------------------
 * CROWD STATE
 * ---------------------------------------------------------
 */

export interface CrowdStats {
  totalTaps: number;

  tapsLastSecond: number;

  tapsLast5Seconds: number;

  tapsLast10Seconds: number;

  energy: number;

  activeConnections: number;

  updatedAt: number;
}