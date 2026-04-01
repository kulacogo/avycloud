'use strict';

/**
 * Global eBay API Rate-Limiter (Token-Bucket + Sliding Window).
 *
 * - Per-second: Token bucket (refills every second)
 * - Per-hour / per-day: Sliding window counters
 * - acquireSlot() returns a Promise that resolves when a slot is available
 * - No external dependencies
 */

const MAX_CALLS_PER_SECOND = parseInt(process.env.EBAY_MAX_CALLS_PER_SECOND || '4', 10);
const MAX_CALLS_PER_HOUR = parseInt(process.env.EBAY_MAX_CALLS_PER_HOUR || '4500', 10);
const MAX_CALLS_PER_DAY = parseInt(process.env.EBAY_MAX_CALLS_PER_DAY || '4500', 10);

const ONE_SECOND = 1000;
const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

// Sliding window timestamps
const callTimestamps = [];

// Queue of pending waiters
const waitQueue = [];

function pruneTimestamps(now) {
  // Remove timestamps older than 24h
  while (callTimestamps.length > 0 && now - callTimestamps[0] > ONE_DAY) {
    callTimestamps.shift();
  }
}

function countInWindow(now, windowMs) {
  let count = 0;
  for (let i = callTimestamps.length - 1; i >= 0; i--) {
    if (now - callTimestamps[i] <= windowMs) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

function getWaitTime(now) {
  pruneTimestamps(now);

  // Check per-second limit
  const callsLastSecond = countInWindow(now, ONE_SECOND);
  if (callsLastSecond >= MAX_CALLS_PER_SECOND) {
    // Wait until the oldest call in the last second expires
    const oldestInSecond = callTimestamps[callTimestamps.length - callsLastSecond];
    return (oldestInSecond + ONE_SECOND) - now + 1;
  }

  // Check per-hour limit
  const callsLastHour = countInWindow(now, ONE_HOUR);
  if (callsLastHour >= MAX_CALLS_PER_HOUR) {
    const oldestInHour = callTimestamps[callTimestamps.length - callsLastHour];
    return (oldestInHour + ONE_HOUR) - now + 1;
  }

  // Check per-day limit
  const callsLastDay = callTimestamps.length;
  if (callsLastDay >= MAX_CALLS_PER_DAY) {
    return (callTimestamps[0] + ONE_DAY) - now + 1;
  }

  return 0;
}

function processQueue() {
  while (waitQueue.length > 0) {
    const now = Date.now();
    const waitMs = getWaitTime(now);
    if (waitMs > 0) {
      // Schedule next check
      setTimeout(processQueue, waitMs);
      return;
    }
    // Grant a slot
    callTimestamps.push(now);
    const resolve = waitQueue.shift();
    resolve();
  }
}

/**
 * Acquire a rate-limit slot. Resolves when it's safe to make an API call.
 * @returns {Promise<void>}
 */
function acquireSlot() {
  const now = Date.now();
  pruneTimestamps(now);
  const waitMs = getWaitTime(now);

  if (waitMs <= 0 && waitQueue.length === 0) {
    // Slot available immediately
    callTimestamps.push(now);
    return Promise.resolve();
  }

  // Queue the request
  return new Promise((resolve) => {
    waitQueue.push(resolve);
    if (waitQueue.length === 1) {
      // First waiter — schedule processing
      setTimeout(processQueue, waitMs > 0 ? waitMs : 1);
    }
  });
}

/**
 * Get current usage stats (for monitoring/logging).
 */
function getUsage() {
  const now = Date.now();
  pruneTimestamps(now);
  return {
    lastSecond: countInWindow(now, ONE_SECOND),
    lastHour: countInWindow(now, ONE_HOUR),
    lastDay: callTimestamps.length,
    limits: {
      perSecond: MAX_CALLS_PER_SECOND,
      perHour: MAX_CALLS_PER_HOUR,
      perDay: MAX_CALLS_PER_DAY,
    },
    queueLength: waitQueue.length,
  };
}

/**
 * Reset all state (for testing only).
 */
function _reset() {
  callTimestamps.length = 0;
  waitQueue.length = 0;
}

module.exports = {
  acquireSlot,
  getUsage,
  _reset,
};
