# Sondex OSS

Sondex OSS is the self-hosted, local-first version of Sondex. It stores contact memory, interactions, payments, and relationship workflows in Postgres and exposes a compact context API for OpenClaw.

## Quick Start

```bash
npm install
npm link
sondex init
sondex start
```

By default, Sondex serves on `http://localhost:3200`.

## Docker Quick Start

```bash
docker compose up --build
```

This starts Postgres + Sondex with `DATABASE_URL=postgresql://postgres:postgres@db:5432/sondex`.

## Configuration Reference

Default config path: `~/.config/sondex/config.json`

```json
{
  "port": 3200,
  "database_url": "postgresql://localhost:5432/sondex",
  "anthropic_api_key": "sk-ant-...",
  "agentmail": {
    "api_key": "am_...",
    "inbox": "you@yourdomain.com",
    "webhook_secret": "whsec_..."
  },
  "stripe": {
    "api_key": "sk_live_...",
    "webhook_secret": "whsec_..."
  },
  "gmail": {
    "client_id": "google-client-id",
    "client_secret": "google-client-secret",
    "refresh_token": "google-refresh-token",
    "poll_interval_seconds": 300
  },
  "imap": {
    "host": "imap.gmail.com",
    "port": 993,
    "user": "you@yourdomain.com",
    "password": "app-password",
    "tls": true,
    "poll_interval_seconds": 300
  },
  "openclaw_webhook_url": "http://localhost:4440/api/system-event"
}
```

Environment overrides supported:

- `DATABASE_URL`, `PORT`
- `ANTHROPIC_API_KEY`
- `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX`, `AGENTMAIL_WEBHOOK_SECRET`
- `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`
- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_POLL_INTERVAL_SECONDS`
- `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASSWORD`, `IMAP_TLS`, `IMAP_POLL_INTERVAL_SECONDS`
- `OPENCLAW_WEBHOOK_URL`
- `SONDEX_CONFIG_PATH`

### Gmail setup

1. Add `gmail.client_id` and `gmail.client_secret` to config.
2. Run `sondex connect-gmail` to complete OAuth and save `gmail.refresh_token`.
3. Start Sondex. Gmail sync starts automatically on boot if credentials are configured.

### IMAP setup

1. Add `imap.host`, `imap.port`, `imap.user`, `imap.password`, and `imap.tls` to config.
2. Start Sondex. IMAP sync starts automatically on boot if credentials are configured.
3. Optional: set `imap.poll_interval_seconds` (default: 300 / 5 min).

## API Reference

### Contacts

- `GET /api/contacts?search=query`
- `POST /api/contacts`
- `GET /api/contacts/:id`
- `PATCH /api/contacts/:id`
- `DELETE /api/contacts/:id`

### Interactions and payments

- `GET /api/contacts/:id/interactions`
- `GET /api/contacts/:id/payments`

### Summaries and merging

- `POST /api/contacts/:id/summarize`
- `POST /api/contacts/:id/merge`

Merge payload:

```json
{
  "merge_contact_id": "uuid"
}
```

### Relationship workflows

- `GET /api/contacts/:id/workflows`
- `POST /api/contacts/:id/workflows`
- `PATCH /api/contacts/:id/workflows`

Patch payload:

```json
{
  "id": "workflow-uuid",
  "status": "waiting",
  "next_action": "Follow up next Tuesday"
}
```

### Context API (OpenClaw-critical)

- `GET /api/v1/context/:identifier`

`identifier` can be contact UUID, primary email, or email alias. Response is compact and LLM-friendly with:

- contact card + summary
- relationship status
- recent interactions (metadata + compact body summary)
- payment rollup and recent transactions

### Webhooks

- `POST /api/webhooks/agentmail`
- `POST /api/webhooks/stripe`

### Manual email sync

- `POST /api/sync/gmail`
- `POST /api/sync/imap`

If webhook secrets are set in config, include one of:

- `x-webhook-secret`
- `x-sondex-webhook-secret`
- `stripe-signature` (stripe route also accepts this header)

## OpenClaw Integration Guide

1. Start Sondex locally (`sondex start`).
2. Before replying to email, fetch sender context:
   `curl -s http://localhost:3200/api/v1/context/person@email.com | jq`
3. Configure inbound event webhooks:
   - AgentMail -> `POST /api/webhooks/agentmail`
   - Stripe -> `POST /api/webhooks/stripe`
4. Trigger manual email sync if needed:
   - Gmail -> `POST /api/sync/gmail`
   - IMAP -> `POST /api/sync/imap`
5. Use `openclaw-skill/SKILL.md` as your reusable OpenClaw skill template.

## CLI

- `sondex init` - create config + run migrations
- `sondex connect-gmail` - run Gmail OAuth and store refresh token
- `sondex start` - start API server
- `sondex migrate` - run migrations
- `sondex status` - print URL, DB health, contact count, last webhook timestamp, connected email sources

## Contributing

1. `npm install`
2. `sondex init`
3. `sondex start`
4. Submit PRs with tests or reproducible curl examples for new behavior.
