// === rate-limiter.js ===
/**
 * @module rate-limiter
 * @description Token bucket rate limiter with exponential backoff and jitter.
 *   Ensures pipeline requests respect per-domain rate limits and prevents
 *   overloading target servers.
 *
 *   Design decision: Token bucket is preferred over sliding window because it
 *   naturally handles burst allowance while maintaining a sustainable average
 *   rate. Per-domain state is tracked in a Map so different targets get
 *   independent buckets.
 *
 * @dependencies logger
 */

import { logger } from "../utils/logger.js";

const MODULE = "rate-limiter";

/**
 * @typedef {Object} BucketConfig
 * @property {number} capacity    - Max tokens (burst limit)
 * @property {number} refillRate  - Tokens per second
 * @property {number} tokens      - Current token count
 * @property {number} lastRefill  - Timestamp of last refill (ms)
 */

/** @type {Map<string, BucketConfig>} domain → bucket */
const _buckets = new Map();

// Retry state per domain
const _retryState = new Map(); // domain → { attempts, nextRetryAt }

const DEFAULT_CAPACITY = 10; // burst of 10
const DEFAULT_REFILL_RATE = 1; // 1 token/second → 60/min sustainable

/**
 * Initialize a rate limit bucket for a domain.
 * @param {string} domain
 * @param {object} [opts]
 * @param {number} [opts.capacity=10]
 * @param {number} [opts.refillRate=1] - tokens per second
 */
export function initBucket(
  domain,
  { capacity = DEFAULT_CAPACITY, refillRate = DEFAULT_REFILL_RATE } = {},
) {
  _buckets.set(domain, {
    capacity,
    refillRate,
    tokens: capacity,
    lastRefill: Date.now(),
  });
  logger.debug(MODULE, "bucket-init", { domain, capacity, refillRate });
}

/**
 * Refill tokens based on elapsed time.
 * @param {BucketConfig} bucket
 */
function _refill(bucket) {
  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000; // seconds
  const added = elapsed * bucket.refillRate;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + added);
  bucket.lastRefill = now;
}

/**
 * Acquire a token for a domain. If unavailable, waits until one is available.
 * @param {string} domain
 * @param {number} [count=1] - number of tokens to consume
 * @returns {Promise<void>}
 */
export async function acquire(domain, count = 1) {
  if (!_buckets.has(domain)) initBucket(domain);
  const bucket = _buckets.get(domain);

  // Looped, not recursed: under contention this used to build one await frame
  // per retry, and a busy domain could stack a lot of them.
  for (;;) {
    _refill(bucket);

    if (bucket.tokens >= count) {
      bucket.tokens -= count;
      logger.debug(MODULE, "token-acquired", {
        domain,
        remaining: Math.floor(bucket.tokens),
      });
      return;
    }

    const deficit = count - bucket.tokens;
    const waitMs = Math.ceil((deficit / bucket.refillRate) * 1000);
    logger.debug(MODULE, "token-wait", { domain, waitMs });
    await _sleep(waitMs);
  }
}

/**
 * Exponential backoff with jitter for retry scenarios.
 * @param {string} domain
 * @param {number} [baseMs=1000]
 * @param {number} [maxMs=60000]
 * @param {number} [maxAttempts=5]
 * @returns {Promise<void>} resolves when next retry is allowed or throws if maxAttempts exceeded
 */
export async function backoff(
  domain,
  baseMs = 1000,
  maxMs = 60_000,
  maxAttempts = 5,
) {
  if (!_retryState.has(domain)) {
    _retryState.set(domain, { attempts: 0, nextRetryAt: 0 });
  }
  const state = _retryState.get(domain);

  if (state.attempts >= maxAttempts) {
    _retryState.delete(domain);
    throw new Error(
      `Max retries (${maxAttempts}) exceeded for domain: ${domain}`,
    );
  }

  // Exponential with ±20% jitter
  const exp = Math.pow(2, state.attempts);
  const delay = Math.min(baseMs * exp, maxMs);
  const jitter = delay * 0.2 * (Math.random() * 2 - 1);
  const waitMs = Math.max(0, Math.round(delay + jitter));

  state.attempts++;
  state.nextRetryAt = Date.now() + waitMs;

  logger.info(MODULE, "backoff-wait", {
    domain,
    attempt: state.attempts,
    waitMs,
  });
  await _sleep(waitMs);
}

/**
 * Reset retry state for a domain (call on success).
 * @param {string} domain
 */
export function resetRetry(domain) {
  _retryState.delete(domain);
}

/** @param {number} ms */
function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// === END rate-limiter.js ===
