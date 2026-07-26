/** How long a write operation's confirmation token stays redeemable. */
export const CONFIRMATION_TTL_MS = 5 * 60_000;

/** How long an unfinished OTP login — and its open browser — is kept alive. */
export const OTP_CHALLENGE_TTL_MS = 5 * 60_000;

/** Hard ceiling on rows a single `sqlQuery` may return. */
export const MAX_QUERY_ROWS = 500;

/** Wall-clock budget for one `sqlQuery`, so a pathological query cannot hang the server. */
export const QUERY_TIMEOUT_MS = 5_000;
