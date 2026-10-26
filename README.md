# Simple CRM

A small CRM app with two pages:

- `/` — a form to submit your email, your message and an optional attachment (max 10 MB), protected by a captcha, with a Send button.
- `/messages` — the list of submitted messages in a table with three columns (email, message and attachment, with a download link when a file was attached).

Built with Node.js, Express and EJS, storing messages in PostgreSQL, and ready to deploy on [Upsun](https://upsun.com).

The UI uses a dark, high-contrast theme inspired by Upsun: Space Grotesk type (loaded from Google Fonts, with Inter/system fallbacks), indigo pill buttons and outlined secondary buttons. All styling lives in `public/css/styles.css`.

## Local development

Requirements: Node.js 26 (`.nvmrc` pins 26.12.1 for local development) and a
PostgreSQL database. On Upsun, the `nodejs:26` image provides the latest 26.x
patch release.

```bash
npm install
cp .env.example .env            # then adjust DATABASE_URL / CAPTCHA_SECRET
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/crm
export CAPTCHA_SECRET=some-long-random-string
npm run migrate                 # creates/updates the messages table (idempotent)
npm start                       # http://localhost:3000
```

Run the tests (they do not need a database):

```bash
npm test
```

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | locally | PostgreSQL connection string. On Upsun the credentials are read from `PLATFORM_RELATIONSHIPS` instead. |
| `CAPTCHA_SECRET` | recommended | Secret used to sign captcha tokens. Without it a random per-process secret is used, so tokens break across restarts and instances. |
| `PORT` | no | HTTP port (default `3000`; Upsun sets it automatically). |

## Captcha

The captcha is a self-contained arithmetic challenge ("What is 7 + 4?"). The expected
answer is not stored server-side: the form carries a signed token
(`HMAC-SHA256(CAPTCHA_SECRET, answer.expiry)`) that is verified on submission and
expires after 10 minutes. A hidden honeypot field adds a second, cheap spam defence.

## Attachments

The contact form has an optional file field. The limit is **10 MB** (10 × 1024 × 1024
bytes): it is enforced on the server (multer, plus a second check in
`src/validate.js`) and hinted in the browser by `public/js/attachment.js`. Larger
files are rejected with HTTP 400 and an error on the form.

Files are stored in PostgreSQL (`attachment_*` columns on `messages`, added by
`migrations/002_attachment.sql`), because the Upsun application filesystem is
read-only at runtime. Run `npm run migrate` to apply it. Downloads are served from
`/messages/:id/attachment` as `application/octet-stream` with a forced-download
header. Note that `/messages` and the downloads are public, like the rest of the app.

## Deploying to Upsun

`.upsun/config.yaml` declares the Node.js application, a PostgreSQL 16 service and
the routes, so the app deploys as-is:

```bash
upsun project:create              # or use an existing project
upsun variable:create --level project --name env:CAPTCHA_SECRET \
  --value "$(openssl rand -hex 32)" --sensitive true
git push upsun main
```

On each deployment the build hook runs `npm ci` and the deploy hook runs
`npm run migrate`, which applies every `.sql` file in `migrations/` in filename
order. The migrations are idempotent, so re-running them is safe.
