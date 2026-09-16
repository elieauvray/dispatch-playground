'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const request = require('supertest');

process.env.CAPTCHA_SECRET = process.env.CAPTCHA_SECRET || 'test-secret';

const captcha = require('../src/captcha');
const { validateSubmission } = require('../src/validate');
const { createApp } = require('../server');

function answerFor(question) {
  const match = /What is (\d+) \+ (\d+)\?/.exec(question);
  assert.ok(match, `unexpected question: ${question}`);
  return String(Number(match[1]) + Number(match[2]));
}

function fakeDb(rows = []) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rows, rowCount: rows.length };
    }
  };
}

function failingDb() {
  return {
    async query() {
      throw new Error('connection refused');
    }
  };
}

function extractChallenge(html) {
  const question = /Anti-spam check: What is \d+ \+ \d+\?/.exec(html);
  const token = /name="captchaToken" value="([^"]+)"/.exec(html);
  assert.ok(question, 'captcha question missing from form');
  assert.ok(token, 'captcha token missing from form');
  return {
    answer: answerFor(question[0].replace('Anti-spam check: ', '')),
    token: token[1]
  };
}

// --- captcha ---------------------------------------------------------------

test('captcha accepts the correct answer', () => {
  const challenge = captcha.create();
  const result = captcha.verify(challenge.token, answerFor(challenge.question));
  assert.equal(result.ok, true);
});

test('captcha rejects a wrong answer', () => {
  const challenge = captcha.create();
  const wrong = String(Number(answerFor(challenge.question)) + 1);
  assert.deepEqual(captcha.verify(challenge.token, wrong), {
    ok: false,
    reason: 'mismatch'
  });
});

test('captcha rejects a tampered or malformed token', () => {
  const challenge = captcha.create();
  const [expiry, digest] = challenge.token.split('.');
  const tampered = `${expiry}.${digest.slice(0, -1)}${digest.endsWith('a') ? 'b' : 'a'}`;
  assert.equal(captcha.verify(tampered, answerFor(challenge.question)).ok, false);
  assert.deepEqual(captcha.verify('nonsense', '5'), { ok: false, reason: 'invalid' });
  assert.deepEqual(captcha.verify('', '5'), { ok: false, reason: 'invalid' });
});

test('captcha rejects an expired token', () => {
  const now = Date.now();
  const challenge = captcha.create(now);
  const later = now + captcha.TTL_MS + 1000;
  assert.deepEqual(
    captcha.verify(challenge.token, answerFor(challenge.question), later),
    { ok: false, reason: 'expired' }
  );
});

// --- validation ------------------------------------------------------------

test('validation accepts a sane submission and trims values', () => {
  const { values, errors } = validateSubmission({
    email: '  someone@example.com  ',
    message: '  hello there  '
  });
  assert.deepEqual(errors, {});
  assert.deepEqual(values, { email: 'someone@example.com', message: 'hello there' });
});

test('validation rejects bad emails and bad messages', () => {
  assert.ok(validateSubmission({ email: '', message: 'hi' }).errors.email);
  assert.ok(validateSubmission({ email: 'not-an-email', message: 'hi' }).errors.email);
  assert.ok(validateSubmission({ email: 'a@b', message: 'hi' }).errors.email);
  assert.ok(
    validateSubmission({ email: `${'a'.repeat(250)}@example.com`, message: 'hi' })
      .errors.email
  );
  assert.ok(validateSubmission({ email: 'a@b.com', message: '   ' }).errors.message);
  assert.ok(
    validateSubmission({ email: 'a@b.com', message: 'x'.repeat(2001) }).errors.message
  );
});

// --- routes ----------------------------------------------------------------

test('GET / renders the form with a captcha', async () => {
  const app = createApp({ db: fakeDb() });
  const res = await request(app).get('/').expect(200);
  assert.match(res.text, /name="email"/);
  assert.match(res.text, /name="message"/);
  assert.match(res.text, /name="captchaToken"/);
  assert.match(res.text, /Send<\/button>/);
});

test('GET /health returns ok', async () => {
  await request(createApp({ db: fakeDb() })).get('/health').expect(200, 'ok');
});

test('valid POST / inserts one row and redirects', async () => {
  const db = fakeDb();
  const app = createApp({ db });
  const form = await request(app).get('/').expect(200);
  const challenge = extractChallenge(form.text);

  const res = await request(app)
    .post('/')
    .type('form')
    .send({
      email: 'someone@example.com',
      message: 'Hello from the test',
      captchaAnswer: challenge.answer,
      captchaToken: challenge.token,
      website: ''
    })
    .expect(303);

  assert.equal(res.headers.location, '/messages?sent=1');
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].text, /INSERT INTO messages/);
  assert.deepEqual(db.calls[0].params, ['someone@example.com', 'Hello from the test']);
});

test('POST / with an invalid email re-renders the form without inserting', async () => {
  const db = fakeDb();
  const app = createApp({ db });
  const form = await request(app).get('/').expect(200);
  const challenge = extractChallenge(form.text);

  const res = await request(app)
    .post('/')
    .type('form')
    .send({
      email: 'nope',
      message: 'Preserved message',
      captchaAnswer: challenge.answer,
      captchaToken: challenge.token
    })
    .expect(400);

  assert.match(res.text, /valid email address/);
  assert.match(res.text, /Preserved message/);
  assert.equal(db.calls.length, 0);
});

test('POST / with a wrong captcha answer is rejected', async () => {
  const db = fakeDb();
  const app = createApp({ db });
  const form = await request(app).get('/').expect(200);
  const challenge = extractChallenge(form.text);

  const res = await request(app)
    .post('/')
    .type('form')
    .send({
      email: 'someone@example.com',
      message: 'Hello',
      captchaAnswer: String(Number(challenge.answer) + 3),
      captchaToken: challenge.token
    })
    .expect(400);

  assert.match(res.text, /Incorrect answer/);
  assert.equal(db.calls.length, 0);
});

test('POST / with a filled honeypot is rejected as spam', async () => {
  const db = fakeDb();
  const app = createApp({ db });
  const form = await request(app).get('/').expect(200);
  const challenge = extractChallenge(form.text);

  const res = await request(app)
    .post('/')
    .type('form')
    .send({
      email: 'someone@example.com',
      message: 'Hello',
      captchaAnswer: challenge.answer,
      captchaToken: challenge.token,
      website: 'http://spam.example'
    })
    .expect(400);

  assert.match(res.text, /looks like spam/);
  assert.equal(db.calls.length, 0);
});

test('GET /messages renders rows escaped in a two-column table', async () => {
  const db = fakeDb([
    { email: 'a@example.com', message: '<script>alert(1)</script>' }
  ]);
  const res = await request(createApp({ db })).get('/messages').expect(200);
  assert.match(res.text, /<th scope="col">Email<\/th>/);
  assert.match(res.text, /<th scope="col">Message<\/th>/);
  assert.match(res.text, /a@example.com/);
  assert.match(res.text, /&lt;script&gt;/);
  assert.doesNotMatch(res.text, /<script>alert\(1\)<\/script>/);
});

test('GET /messages shows an empty state and the success banner', async () => {
  const res = await request(createApp({ db: fakeDb() }))
    .get('/messages?sent=1')
    .expect(200);
  assert.match(res.text, /No messages yet/);
  assert.match(res.text, /has been saved/);
});

test('database errors render the 500 page without a stack trace', async () => {
  const res = await request(createApp({ db: failingDb() }))
    .get('/messages')
    .expect(500);
  assert.match(res.text, /Something went wrong/);
  assert.doesNotMatch(res.text, /connection refused/);
});

test('unknown URLs render the 404 page', async () => {
  const res = await request(createApp({ db: fakeDb() }))
    .get('/does-not-exist')
    .expect(404);
  assert.match(res.text, /Page not found/);
});
