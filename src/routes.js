'use strict';

const express = require('express');

const captcha = require('./captcha');
const defaultDb = require('./db');
const { validateSubmission, MESSAGE_MAX } = require('./validate');

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

  router.post('/', async (req, res, next) => {
    const renderWithErrors = (values, errors) => {
      res.status(400).render('layout', {
        view: 'form',
        title: 'New message',
        values,
        errors,
        challenge: captcha.create()
      });
    };

    // Hidden honeypot field: only bots fill it in.
    if (typeof req.body.website === 'string' && req.body.website.trim() !== '') {
      renderWithErrors(
        { email: '', message: '' },
        { form: 'Your submission looks like spam and was not saved.' }
      );
      return;
    }

    const { values, errors } = validateSubmission(req.body);

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
        'INSERT INTO messages (email, message) VALUES ($1, $2)',
        [values.email, values.message]
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
        'SELECT email, message FROM messages ORDER BY created_at DESC, id DESC'
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

  return router;
}

module.exports = { createRouter, MESSAGE_MAX };
