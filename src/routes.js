'use strict';

const express = require('express');
const multer = require('multer');

const captcha = require('./captcha');
const defaultDb = require('./db');
const {
  validateSubmission,
  validateAttachment,
  MESSAGE_MAX,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TOO_LARGE
} = require('./validate');

const upload = multer({
  storage: multer.memoryStorage(),
  // Busboy decodes filenames as latin1 by default, which mangles non-ASCII names.
  defParamCharset: 'utf8',
  limits: {
    fileSize: ATTACHMENT_MAX_BYTES,
    files: 1,
    fields: 10,
    fieldSize: 64 * 1024
  }
});

/** Build a Content-Disposition value that is safe against header injection. */
function attachmentDisposition(name) {
  name = String(name).toWellFormed();
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Build the application router. The database module is injectable so tests can
 * run without a live PostgreSQL instance.
 */
function createRouter({ db = defaultDb } = {}) {
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.status(200).type('text/plain').send('ok');
  });

  router.get('/', (req, res) => {
    const challenge = captcha.create();
    res.render('layout', {
      view: 'form',
      title: 'New message',
      values: { email: '', message: '' },
      errors: {},
      challenge
    });
  });

  // Parse multipart bodies (urlencoded bodies are already parsed and ignored
  // by multer). Upload errors re-render the form instead of hitting the 500 page.
  const parseUpload = (req, res, next) => {
    upload.single('attachment')(req, res, (err) => {
      if (!err) {
        next();
        return;
      }
      if (!(err instanceof multer.MulterError)) {
        next(err);
        return;
      }

      // Fields may not have been parsed yet when the error fires.
      const body = req.body || {};
      res.status(400).render('layout', {
        view: 'form',
        title: 'New message',
        values: {
          email: typeof body.email === 'string' ? body.email.trim() : '',
          message: typeof body.message === 'string' ? body.message.trim() : ''
        },
        errors: {
          attachment:
            err.code === 'LIMIT_FILE_SIZE'
              ? ATTACHMENT_TOO_LARGE
              : 'The attachment could not be uploaded. Please attach a single file.'
        },
        challenge: captcha.create()
      });
    });
  };

  router.post('/', parseUpload, async (req, res, next) => {
    const renderWithErrors = (values, errors) => {
      res.status(400).render('layout', {
        view: 'form',
        title: 'New message',
        values,
        errors,
        challenge: captcha.create()
      });
    };

    req.body = req.body || {};

    // Hidden honeypot field: only bots fill it in.
    if (typeof req.body.website === 'string' && req.body.website.trim() !== '') {
      renderWithErrors(
        { email: '', message: '' },
        { form: 'Your submission looks like spam and was not saved.' }
      );
      return;
    }

    const { values, errors } = validateSubmission(req.body);

    // Second check in case the multer limit is bypassed or changed.
    const { attachment, error: attachmentError } = validateAttachment(req.file);
    if (attachmentError) {
      errors.attachment = attachmentError;
    }

    const captchaResult = captcha.verify(
      typeof req.body.captchaToken === 'string' ? req.body.captchaToken : '',
      typeof req.body.captchaAnswer === 'string' ? req.body.captchaAnswer : ''
    );
    if (!captchaResult.ok) {
      errors.captcha =
        captchaResult.reason === 'expired'
          ? 'Captcha expired, please try again.'
          : captchaResult.reason === 'invalid'
            ? 'Captcha could not be verified, please try again.'
            : 'Incorrect answer, please try again.';
    }

    if (Object.keys(errors).length > 0) {
      renderWithErrors(values, errors);
      return;
    }

    try {
      await db.query(
        'INSERT INTO messages (email, message, attachment_name, attachment_type, attachment_size, attachment_data) VALUES ($1, $2, $3, $4, $5, $6)',
        [
          values.email,
          values.message,
          attachment ? attachment.name : null,
          attachment ? attachment.type : null,
          attachment ? attachment.size : null,
          attachment ? attachment.data : null
        ]
      );
    } catch (err) {
      next(err);
      return;
    }

    res.redirect(303, '/messages?sent=1');
  });

  router.get('/messages', async (req, res, next) => {
    try {
      const result = await db.query(
        'SELECT id, email, message, attachment_name, attachment_size FROM messages ORDER BY created_at DESC, id DESC'
      );
      res.render('layout', {
        view: 'messages',
        title: 'Messages',
        messages: result.rows,
        sent: req.query.sent === '1'
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/messages/:id/attachment', async (req, res, next) => {
    if (!/^\d{1,18}$/.test(req.params.id)) {
      next();
      return;
    }

    try {
      const result = await db.query(
        'SELECT attachment_name, attachment_data FROM messages WHERE id = $1',
        [req.params.id]
      );
      const row = result.rows[0];
      if (!row || !row.attachment_data) {
        next();
        return;
      }

      const data = row.attachment_data;
      res.set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': attachmentDisposition(row.attachment_name || 'attachment'),
        'X-Content-Type-Options': 'nosniff',
        'Content-Length': String(data.length)
      });
      res.status(200).end(data);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createRouter, MESSAGE_MAX };
