'use strict';

const EMAIL_MAX = 254;
const MESSAGE_MAX = 2000;
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

module.exports = { validateSubmission, EMAIL_MAX, MESSAGE_MAX };
