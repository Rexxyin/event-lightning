import type { CrowdStats } from './types.js';

interface TapEvent {
  timestamp: number;
}

/**
 * Crowd interaction aggregation.
 *
 * Important:
 *
 * Audience taps are GLOBAL.
 *
 * They are not associated with:
 * - zone
 * - row
 * - seat
 *
 * The spatial model only matters when we send
 * a resulting light command back to the audience.
 */
class CrowdManager {
  private totalTaps = 0;

  private taps: TapEvent[] = [];

  private activeConnections = 0;

  private lastUpdatedAt = Date.now();

  /**
   * How long we retain individual tap timestamps.
   *
   * 10 seconds is enough for:
   *
   * - taps/sec
   * - taps/5 sec
   * - taps/10 sec
   * - crowd energy
   *
   * Old events are periodically removed.
   */
  private readonly retentionMs = 10_000;

  /**
   * Record one accepted audience tap.
   */
  recordTap(timestamp = Date.now()): void {
    const now = Date.now();

    this.prune(now);

    this.totalTaps += 1;

    this.taps.push({
      timestamp,
    });

    this.lastUpdatedAt = now;
  }

  /**
   * Track connected audience sockets.
   */
  connectionOpened(): void {
    this.activeConnections += 1;

    this.lastUpdatedAt = Date.now();
  }

  /**
   * Track disconnected audience sockets.
   */
  connectionClosed(): void {
    this.activeConnections = Math.max(
      0,
      this.activeConnections - 1,
    );

    this.lastUpdatedAt = Date.now();
  }

  /**
   * Reset the aggregate interaction counters.
   *
   * Useful before a show or before a new interaction segment.
   */
  reset(): void {
    this.totalTaps = 0;

    this.taps = [];

    this.lastUpdatedAt = Date.now();
  }

  /**
   * Return current crowd state.
   */
  getStats(): CrowdStats {
    const now = Date.now();

    this.prune(now);

    const tapsLastSecond =
      this.countSince(
        now - 1_000,
      );

    const tapsLast5Seconds =
      this.countSince(
        now - 5_000,
      );

    const tapsLast10Seconds =
      this.countSince(
        now - 10_000,
      );

    /**
     * Energy is intentionally based on recent activity,
     * not lifetime taps.
     *
     * This means:
     *
     * 0 taps/sec      → 0 energy
     * high activity   → approaches 100
     *
     * We use a logarithmic curve so a huge crowd does
     * not immediately max the meter.
     */
    const rawRate =
      tapsLastSecond;

    const energy =
      Math.min(
        100,
        Math.round(
          (
            1 -
            Math.exp(
              -rawRate / 8,
            )
          ) * 100,
        ),
      );

    return {
      totalTaps: this.totalTaps,

      tapsLastSecond,

      tapsLast5Seconds,

      tapsLast10Seconds,

      energy,

      activeConnections:
        this.activeConnections,

      updatedAt:
        this.lastUpdatedAt,
    };
  }

  private countSince(
    timestamp: number,
  ): number {
    let count = 0;

    for (
      let index =
        this.taps.length - 1;
      index >= 0;
      index -= 1
    ) {
      const tap =
        this.taps[index];

      if (
        tap.timestamp <
        timestamp
      ) {
        break;
      }

      count += 1;
    }

    return count;
  }

  private prune(
    now: number,
  ): void {
    const cutoff =
      now -
      this.retentionMs;

    let firstValidIndex = 0;

    while (
      firstValidIndex <
        this.taps.length &&
      this.taps[firstValidIndex]
        .timestamp < cutoff
    ) {
      firstValidIndex += 1;
    }

    if (
      firstValidIndex > 0
    ) {
      this.taps =
        this.taps.slice(
          firstValidIndex,
        );
    }
  }
}

export const crowd =
  new CrowdManager();