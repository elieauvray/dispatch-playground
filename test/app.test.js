'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const request = require('supertest');

process.env.CAPTCHA_SECRET = process.env.CAPTCHA_SECRET || 'test-secret';

const captcha = require('../src/captcha');
const {
  validateSubmission,
  validateAttachment,
  sanitizeFilename,
  ATTACHMENT_MAX_BYTES
} = require('../src/validate');
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
  assert.deepEqual(db.calls[0].params, [
    'someone@example.com',
    'Hello from the test',
    null,
    null,
    null,
    null
  ]);
});

async function multipartPost(app, file, extra = {}, status = 303) {
  const form = await request(app).get('/').expect(200);
  const challenge = extractChallenge(form.text);
  const req = request(app)
    .post('/')
    .field('email', 'someone@example.com')
    .field('message', 'Hello with file')
    .field('captchaAnswer', challenge.answer)
    .field('captchaToken', challenge.token);
  for (const [k, v] of Object.entries(extra)) req.field(k, v);
  if (file) req.attach('attachment', file.buffer, file.name);
  return req.expect(status);
}

test('GET / renders a multipart form with a file input', async () => {
  const res = await request(createApp({ db: fakeDb() })).get('/').expect(200);
  assert.match(res.text, /enctype="multipart\/form-data"/);
  assert.match(res.text, /type="file"/);
  assert.match(res.text, /name="attachment"/);
  assert.match(res.text, /Max 10 MB/);
});

test('multipart POST / without a file stores NULL attachment columns', async () => {
  const db = fakeDb();
  const res = await multipartPost(createApp({ db }), null);
  assert.equal(res.headers.location, '/messages?sent=1');
  assert.deepEqual(db.calls[0].params.slice(2), [null, null, null, null]);
});

test('multipart POST / with a small file stores it', async () => {
  const db = fakeDb();
  const buffer = Buffer.from('hello attachment');
  const res = await multipartPost(createApp({ db }), { buffer, name: 'a.txt' });
  assert.equal(res.headers.location, '/messages?sent=1');
  assert.equal(db.calls.length, 1);
  const params = db.calls[0].params;
  assert.equal(params[2], 'a.txt');
  assert.equal(params[4], buffer.length);
  assert.ok(Buffer.isBuffer(params[5]));
  assert.deepEqual(params[5], buffer);
});

test('multipart POST / keeps non-ASCII filenames intact', async () => {
  const db = fakeDb();
  await multipartPost(createApp({ db }), {
    buffer: Buffer.from('x'),
    name: 'répört日本.txt'
  });
  assert.equal(db.calls[0].params[2], 'répört日本.txt');
});

test('multipart POST / accepts a file of exactly 10 MB', async () => {
  const db = fakeDb();
  const buffer = Buffer.alloc(ATTACHMENT_MAX_BYTES);
  await multipartPost(createApp({ db }), { buffer, name: 'big.bin' });
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].params[4], ATTACHMENT_MAX_BYTES);
});

test('multipart POST / rejects a file over 10 MB without inserting', async () => {
  const db = fakeDb();
  const buffer = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1);
  const res = await multipartPost(createApp({ db }), { buffer, name: 'huge.bin' }, {}, 400);
  assert.match(res.text, /Attachment must be 10 MB or smaller\./);
  assert.match(res.text, /name="captchaToken"/);
  assert.equal(db.calls.length, 0);
});

test('multipart POST / with a bad email and a file does not insert', async () => {
  const db = fakeDb();
  const app = createApp({ db });
  const form = await request(app).get('/').expect(200);
  const challenge = extractChallenge(form.text);
  const res = await request(app)
    .post('/')
    .field('email', 'nope')
    .field('message', 'Kept message')
    .field('captchaAnswer', challenge.answer)
    .field('captchaToken', challenge.token)
    .attach('attachment', Buffer.from('x'), 'x.txt')
    .expect(400);
  assert.match(res.text, /valid email address/);
  assert.match(res.text, /Kept message/);
  assert.equal(db.calls.length, 0);
});

test('multipart POST / ignores the file when the honeypot is filled', async () => {
  const db = fakeDb();
  const res = await multipartPost(
    createApp({ db }),
    { buffer: Buffer.from('x'), name: 'x.txt' },
    { website: 'http://spam.example' },
    400
  );
  assert.match(res.text, /looks like spam/);
  assert.equal(db.calls.length, 0);
});

test('multipart POST / with an unexpected file field shows an attachment error', async () => {
  const db = fakeDb();
  const res = await request(createApp({ db }))
    .post('/')
    .attach('other', Buffer.from('x'), 'x.txt')
    .expect(400);
  assert.match(res.text, /could not be uploaded/);
  assert.equal(db.calls.length, 0);
});

// --- attachment validation -------------------------------------------------

test('validateAttachment handles none, small, exact and oversized files', () => {
  assert.deepEqual(validateAttachment(undefined), { attachment: null, error: null });
  assert.deepEqual(validateAttachment({ size: 0 }), { attachment: null, error: null });

  const small = validateAttachment({
    originalname: 'a.txt',
    mimetype: 'text/plain',
    size: 3,
    buffer: Buffer.from('abc')
  });
  assert.equal(small.error, null);
  assert.equal(small.attachment.name, 'a.txt');
  assert.equal(small.attachment.type, 'text/plain');

  assert.equal(
    validateAttachment({ originalname: 'a', size: ATTACHMENT_MAX_BYTES, buffer: Buffer.alloc(0) })
      .error,
    null
  );
  assert.equal(
    validateAttachment({ originalname: 'a', size: ATTACHMENT_MAX_BYTES + 1 }).error,
    'Attachment must be 10 MB or smaller.'
  );
});

test('sanitizeFilename strips paths, quotes and control characters', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('C:\\temp\\evil.exe'), 'evil.exe');
  assert.equal(sanitizeFilename('a"b\r\nc.txt'), 'abc.txt');
  assert.equal(sanitizeFilename(''), 'attachment');
  assert.equal(sanitizeFilename('..'), 'attachment');
  assert.equal(sanitizeFilename(undefined), 'attachment');
  assert.equal(sanitizeFilename('x'.repeat(500)).length, 200);
});

// --- downloads -------------------------------------------------------------

test('GET /messages/:id/attachment serves the bytes as a forced download', async () => {
  const data = Buffer.from('file-bytes');
  const db = fakeDb([{ attachment_name: 'rép ort.txt', attachment_data: data }]);
  const res = await request(createApp({ db }))
    .get('/messages/7/attachment')
    .buffer(true)
    .parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    })
    .expect(200);
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['content-length'], String(data.length));
  assert.match(res.headers['content-disposition'], /^attachment; filename="r_p ort\.txt"; filename\*=UTF-8''r%C3%A9p%20ort\.txt$/);
  assert.deepEqual(res.body, data);
  assert.deepEqual(db.calls[0].params, ['7']);
});

test('GET /messages/:id/attachment returns 404 for bad, unknown or empty rows', async () => {
  await request(createApp({ db: fakeDb([]) }))
    .get('/messages/abc/attachment')
    .expect(404);
  await request(createApp({ db: fakeDb([]) }))
    .get('/messages/99/attachment')
    .expect(404);
  await request(
    createApp({ db: fakeDb([{ attachment_name: null, attachment_data: null }]) })
  )
    .get('/messages/1/attachment')
    .expect(404);
});

test('GET /messages shows download links and a dash for rows without files', async () => {
  const db = fakeDb([
    { id: 3, email: 'a@example.com', message: 'm', attachment_name: '<b>x</b>.txt', attachment_size: 2048 },
    { id: 2, email: 'b@example.com', message: 'n', attachment_name: null, attachment_size: null }
  ]);
  const res = await request(createApp({ db })).get('/messages').expect(200);
  assert.match(res.text, /<th scope="col">Attachment<\/th>/);
  assert.match(res.text, /href="\/messages\/3\/attachment"/);
  assert.match(res.text, /&lt;b&gt;x&lt;\/b&gt;\.txt/);
  assert.match(res.text, /\(2 KB\)/);
  assert.doesNotMatch(res.text, /\/messages\/2\/attachment/);
  assert.doesNotMatch(db.calls[0].text, /attachment_data/);
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
