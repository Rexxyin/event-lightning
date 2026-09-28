import 'dotenv/config';

const adminToken =
  process.env.ADMIN_TOKEN;

if (
  !adminToken ||
  adminToken.length < 32
) {
  throw new Error(
    'ADMIN_TOKEN must be at least 32 characters',
  );
}

export const config = {
  port: Number(
    process.env.PORT ?? 8080,
  ),

  adminToken,

  allowedOrigins: (
    process.env.ALLOWED_ORIGIN ??
    'http://localhost:3000'
  )
    .split(',')
    .map(
      origin =>
        origin.trim(),
    )
    .filter(Boolean),

  /**
   * Audience interaction protection.
   *
   * Users can tap repeatedly.
   *
   * This is NOT a one-vote limit.
   *
   * It simply prevents a single browser from
   * accidentally or maliciously generating
   * thousands of events per second.
   */
  audienceRateLimit: {
    /**
     * Sustained accepted taps/sec per socket.
     */
    ratePerSecond: Number(
      process.env.AUDIENCE_TAPS_PER_SECOND ??
        20,
    ),

    /**
     * Allow short bursts above the sustained rate.
     */
    burst: Number(
      process.env.AUDIENCE_TAP_BURST ??
        40,
    ),
  },
};