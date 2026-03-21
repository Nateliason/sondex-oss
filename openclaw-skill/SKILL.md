# Sondex Context Skill

Use local Sondex before replying to people so your responses include relationship memory.

## Local API

- Base URL: `http://localhost:3200`
- Context endpoint: `GET /api/v1/context/:identifier`

Examples:

```bash
curl -s http://localhost:3200/api/v1/context/person@email.com | jq
curl -s http://localhost:3200/api/v1/context/9c5f5c5d-ffff-4f65-9876-aaaaaaaaaaaa | jq
```

## Workflow

1. Before drafting a reply, fetch context by sender email.
2. Use `contact.summary`, `recent_interactions`, and `relationship.next_action` to tailor tone and content.
3. If Sondex has no record, proceed with a neutral reply and trigger a manual sync if needed.

## Webhook Setup

Configure OpenClaw system-event webhook URL:

- `http://localhost:4440/api/system-event`

Then point AgentMail and Stripe events to Sondex:

- AgentMail: `POST http://localhost:3200/api/webhooks/agentmail`
- Stripe: `POST http://localhost:3200/api/webhooks/stripe`

Optional manual sync triggers:

- Gmail: `POST http://localhost:3200/api/sync/gmail`
- IMAP: `POST http://localhost:3200/api/sync/imap`

Set matching secrets in `~/.config/sondex/config.json`.
