'use strict';

const path = require('path');

const EMAIL_MAX = 254;
const MESSAGE_MAX = 2000;
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_NAME_MAX = 200;
const ATTACHMENT_TOO_LARGE = 'Attachment must be 10 MB or smaller.';
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Validate a submission.
 * Returns { values: { email, message }, errors: { email?, message? } }.
 */
function validateSubmission(body = {}) {
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const errors = {};

  if (!email) {
    errors.email = 'Please enter your email address.';
  } else if (email.length > EMAIL_MAX) {
    errors.email = `Email address must be ${EMAIL_MAX} characters or fewer.`;
  } else if (!EMAIL_RE.test(email)) {
    errors.email = 'Please enter a valid email address.';
  }

  if (!message) {
    errors.message = 'Please enter your message.';
  } else if (message.length > MESSAGE_MAX) {
    errors.message = `Message must be ${MESSAGE_MAX} characters or fewer.`;
  }

  return { values: { email, message }, errors };
}

/**
 * Reduce a client-supplied filename to a safe display/storage name: base name
 * only, no control characters, quotes or path separators, capped in length.
 */
function sanitizeFilename(name) {
  const raw = typeof name === 'string' ? name : '';
  const base = path.basename(raw.replace(/\\/g, '/'));
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"'\\/]/g, '')
    .trim()
    .slice(0, ATTACHMENT_NAME_MAX)
    .trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'attachment';
}

/**
 * Validate the optional uploaded file (a multer memory-storage file object).
 * Returns { attachment, error }. `attachment` is null when there is no file.
 */
function validateAttachment(file) {
  if (!file || !file.size) {
    return { attachment: null, error: null };
  }

  if (file.size > ATTACHMENT_MAX_BYTES) {
    return { attachment: null, error: ATTACHMENT_TOO_LARGE };
  }

  return {
    attachment: {
      name: sanitizeFilename(file.originalname),
      type:
        typeof file.mimetype === 'string' && file.mimetype
          ? file.mimetype.slice(0, 200)
          : 'application/octet-stream',
      size: file.size,
      data: file.buffer
    },
    error: null
  };
}

module.exports = {
  validateSubmission,
  validateAttachment,
  sanitizeFilename,
  EMAIL_MAX,
  MESSAGE_MAX,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TOO_LARGE
};
