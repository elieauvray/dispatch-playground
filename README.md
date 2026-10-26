# Simple CRM

A small CRM app with two pages:

- `/` — a form to submit your email and your message, protected by a captcha, with a Send button.
- `/messages` — the list of submitted messages in a table with two columns (email and message).

Built with Node.js, Express and EJS, storing messages in PostgreSQL, and ready to deploy on [Upsun](https://upsun.com).

The UI uses a dark, high-contrast theme inspired by Upsun: Space Grotesk type (loaded from Google Fonts, with Inter/system fallbacks), indigo pill buttons and outlined secondary buttons. All styling lives in `public/css/styles.css`.

## Local development

Requirements: Node.js 20+ and a PostgreSQL database.

```bash
npm install
cp .env.example .env            # then adjust DATABASE_URL / CAPTCHA_SECRET
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/crm
export CAPTCHA_SECRET=some-long-random-string
npm run migrate                 # creates the messages table (idempotent)
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
