# CEASAR ENTERPRISE Manager

A single-file herd, farmer and finance manager for a goat cooperative. Track
every animal, every farmer, every shilling in and out, and see the ten-year
projection — from one dark dashboard that works with the internet switched off.

**Zero dependencies. One 400-line server. Plain JSON on disk.** Nothing to
install, no database to provision, no cloud account. Clone it, run it, own it.

---

## What it does

| Panel | What you get |
| --- | --- |
| **Herd** | Every goat with tag, breed, sex, birth date, owner, price and status. Live totals: head count, value, average price. |
| **Farmers** | Cooperative member register - name, phone, village, animals contributed, joined date. |
| **Transactions** | Income and expenses: sales, purchases, feed, vet, transport. Running balance and category breakdown. |
| **Projections** | Ten-year net-profit and farmer-growth model you can edit. Your plan, not a vendor's. |
| **Activity Log** | Every create, update and delete, with a timestamp. An audit trail your accountant can read. |
| **Assistant** | Ask questions in plain language ("which farmer is behind on feed?"). Answers come from a local LLM. |

Everything is editable in place, searchable, and exportable.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer. That is the entire list.
- Optional: [Ollama](https://ollama.com) for the assistant panel. Everything else
  works without it.

## Quick start

```bash
git clone https://github.com/ceasar-enterprises/ceasar-enterprise-manager.git
cd ceasar-enterprise-manager
node index.js
```

Open **http://localhost:3002**.

On Windows, double-click **`Start.bat`**.

### First run

There is **no default password**. The app boots unconfigured and waits for you:

1. Open the dashboard.
2. Set a password of 8+ characters.
3. That password is now the admin password.

Setup can only be completed once. To reset it later, stop the server, delete
`data/auth.json`, and start again.

## Configuration

Everything has a working default, so you can ignore this section entirely.
See `.env.example` for the full list.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3002` | HTTP port for the dashboard. |
| `SESSION_SECRET` | random per boot | Signs session tokens. **Set it** so logins survive a restart. |
| `CEM_DATA_DIR` | `./data` | Where the JSON files live. Move it outside the repo to keep data out of version control. |
| `AI_ENDPOINT` | `http://localhost:11434` | Any OpenAI-compatible LLM server (Ollama works). |

Generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## The assistant panel

The assistant answers questions about **your** farm — herd, farmers,
transactions and projections are serialised into the prompt, so the model
reasons about your actual numbers instead of generic advice.

It talks to a local, OpenAI-compatible endpoint. With [Ollama](https://ollama.com):

```bash
ollama pull qwen2.5-coder:7b
```

If nothing is listening, the panel reports `AI unavailable` and the rest of the
app is unaffected. **No farm data ever leaves your machine** unless you point
`AI_ENDPOINT` at a remote server yourself.

## Security

- **No built-in password.** A fresh install is unconfigured and demands first-time
  setup. There is no default credential to forget to change.
- **Salted scrypt hashing** (`salt:key`, 16-byte salt, 64-byte key). Passwords are
  never stored, logged, or recoverable in plaintext.
- **HMAC-signed session tokens** with a 24-hour expiry. Tampering invalidates the
  token.
- **The whole API is authenticated** except `POST /api/setup`, `POST /api/login`
  and `GET /api/auth-status` — and setup self-disables once a password exists.
- **Path traversal is blocked** on static file serving.
- **`data/` is gitignored.** Your password hash and farm records never enter git.

> This is designed for a single farm on a trusted network. Before exposing it to
> the public internet, put it behind a TLS-terminating reverse proxy (Caddy,
> nginx) and set a strong `SESSION_SECRET`. There is no built-in account
> management — one admin password, one operator.

## Data

Plain JSON, one file per collection, written on every change:

```
data/
  auth.json         scrypt password hash          (created on first setup)
  herd.json         animals
  farmers.json      cooperative members
  transactions.json income and expenses
  projections.json  ten-year model
  events.json       activity log
```

Back it up by copying the folder. Restore it the same way. That is the whole
backup strategy, and it works.

To keep data outside the project directory entirely:

```bash
CEM_DATA_DIR=/srv/ceasar-data node index.js
```

## Tests

```bash
npm test
```

Twelve cases covering the parts that matter:

- password hashing is salted, round-trips, and rejects a malformed stored hash
- tokens round-trip, expire, and reject a foreign signing secret
- the hardcoded default password is absent from the source
- a fresh install starts unconfigured and refuses login
- setup rejects weak passwords and cannot be replayed
- login rejects wrong passwords and issues valid tokens
- protected routes reject anonymous, bogus and forged tokens
- static files serve, and traversal is refused

Tests import the server and point `CEM_DATA_DIR` at a scratch directory, so
they never touch your real `data/`.

## Project layout

```
index.js              the entire server - HTTP, storage, auth, AI
public/index.html     the dashboard (single page, no build step)
tests/auth.test.js    auth, session and static-file tests
Start.bat             Windows launcher
```

No build step, no bundler, no `npm install`. That is deliberate: a farm office
computer should be able to run this for years.

## API

All routes except setup/login/auth-status require `Authorization: Bearer <token>`.

```
GET    /api/herd              POST /api/herd              PUT/DELETE /api/herd
GET    /api/herd/stats
GET    /api/farmers           POST /api/farmers           PUT/DELETE /api/farmers
GET    /api/finances          POST /api/finances          PUT/DELETE /api/finances
GET    /api/finances/summary  PUT  /api/finances/bulk
GET    /api/projections       PUT  /api/projections
GET    /api/events            POST /api/events
POST   /api/ai/query
POST   /api/setup   POST /api/login   GET /api/auth-status
```

## License

MIT — see [LICENSE](LICENSE).

Built by **Ceasar Enterprises**.
