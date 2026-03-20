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
  "openclaw_webhook_url": "http://localhost:4440/api/system-event"
}
```

Environment overrides supported:

- `DATABASE_URL`, `PORT`
- `ANTHROPIC_API_KEY`
- `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX`, `AGENTMAIL_WEBHOOK_SECRET`
- `STRIPE_API_KEY`, `STRIPE_WEBHOOK_SECRET`
- `OPENCLAW_WEBHOOK_URL`
- `SONDEX_CONFIG_PATH`

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
4. Use `openclaw-skill/SKILL.md` as your reusable OpenClaw skill template.

## CLI

- `sondex init` - create config + run migrations
- `sondex start` - start API server
- `sondex migrate` - run migrations
- `sondex status` - print URL, DB health, contact count, last webhook timestamp

## Contributing

1. `npm install`
2. `sondex init`
3. `sondex start`
4. Submit PRs with tests or reproducible curl examples for new behavior.
