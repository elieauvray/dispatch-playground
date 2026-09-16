'use strict';

const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000; // 10 minutes

let warned = false;

function getSecret() {
  if (process.env.CAPTCHA_SECRET) {
    return process.env.CAPTCHA_SECRET;
  }
  if (!warned) {
    warned = true;
    console.warn(
      'CAPTCHA_SECRET is not set: using a random per-process secret. ' +
        'Captcha tokens will not survive restarts or multiple instances.'
    );
  }
  if (!getSecret.fallback) {
    getSecret.fallback = crypto.randomBytes(32).toString('hex');
  }
  return getSecret.fallback;
}

function sign(answer, expiresAt) {
  return crypto
    .createHmac('sha256', getSecret())
    .update(`${answer}.${expiresAt}`)
    .digest('hex');
}

/**
 * Create a stateless arithmetic captcha challenge.
 * The token carries the expiry and an HMAC of the expected answer, so no
 * server-side session storage is required.
 */
function create(now = Date.now()) {
  const a = crypto.randomInt(1, 10);
  const b = crypto.randomInt(1, 10);
  const answer = a + b;
  const expiresAt = now + TTL_MS;

  return {
    question: `What is ${a} + ${b}?`,
    token: `${expiresAt}.${sign(answer, expiresAt)}`
  };
}

/**
 * Verify a submitted captcha answer against its token.
 * Returns { ok: true } or { ok: false, reason: 'invalid' | 'expired' | 'mismatch' }.
 */
function verify(token, userAnswer, now = Date.now()) {
  if (typeof token !== 'string' || typeof userAnswer !== 'string') {
    return { ok: false, reason: 'invalid' };
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return { ok: false, reason: 'invalid' };
  }

  const expiresAt = Number(parts[0]);
  const digest = parts[1];
  if (!Number.isFinite(expiresAt) || !/^[0-9a-f]{64}$/.test(digest)) {
    return { ok: false, reason: 'invalid' };
  }

  if (now > expiresAt) {
    return { ok: false, reason: 'expired' };
  }

  const trimmed = userAnswer.trim();
  if (!/^-?\d{1,4}$/.test(trimmed)) {
    return { ok: false, reason: 'mismatch' };
  }

  const expected = Buffer.from(sign(Number(trimmed), expiresAt), 'utf8');
  const provided = Buffer.from(digest, 'utf8');
  if (expected.length !== provided.length) {
    return { ok: false, reason: 'mismatch' };
  }
  if (!crypto.timingSafeEqual(expected, provided)) {
    return { ok: false, reason: 'mismatch' };
  }

  return { ok: true };
}

module.exports = { create, verify, TTL_MS };
