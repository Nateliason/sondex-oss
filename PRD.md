# PRD: Sondex OSS — Local Self-Hosted Version

## Overview
Open-source, self-hosted version of Sondex that runs locally with Postgres. Same core functionality as the hosted version but designed for developers who want to run it on their own machine alongside OpenClaw.

## Repo
`Nateliason/sondex-oss` (new repo, public, MIT license)

## Stack
- **Runtime:** Node.js (Bun compatible)
- **Database:** Local Postgres via `pg` driver + Drizzle ORM
- **Server:** Hono (lightweight, fast, runs anywhere)
- **No auth** — single-user local mode, no login required
- **Config:** `~/.config/sondex/config.json` for API keys and settings
- **Process management:** Can run standalone or via launchd/systemd

## Core Features (match hosted Sondex)

### 1. Contact Storage
- Store contacts with: name, email, company, tags, summary, email_aliases
- CRUD API: `GET/POST /api/contacts`, `GET/PATCH/DELETE /api/contacts/:id`
- Search by name/email: `GET /api/contacts?search=query`

### 2. Interaction Memory
- Store email conversations, mapped to contacts
- `GET /api/contacts/:id/interactions` — conversation timeline
- Auto-link inbound emails to existing contacts by email address

### 3. Payment Memory (optional Stripe integration)
- Store payment history per contact
- `GET /api/contacts/:id/payments`
- Stripe webhook handler to auto-ingest charges

### 4. Context API (the key endpoint for OpenClaw)
- `GET /api/v1/context/:identifier` — returns everything Sondex knows about a person
  - identifier can be email address or contact ID
  - Returns: contact info, summary, recent interactions, payment history, relationship status
  - This is what OpenClaw queries before replying to someone
- Response should be compact and LLM-friendly (not full HTML email bodies — summaries and metadata)

### 5. Webhook Receivers
- `POST /api/webhooks/agentmail` — receives new email events, creates/updates contacts and interactions
- `POST /api/webhooks/stripe` — receives payment events, creates/updates payment records
- Webhook secret validation via config

### 6. Memory Summaries
- `POST /api/contacts/:id/summarize` — regenerate a contact's memory summary using an LLM
- Uses the configured LLM provider (Anthropic by default)
- Summarizes: who they are, conversation history, purchase history, relationship status
- Stores result in `contacts.summary`

### 7. Contact Merging
- `POST /api/contacts/:id/merge` — merge two contacts (same person, different emails)
- Re-parents all interactions, payments
- Stores secondary email in `email_aliases`

### 8. Relationship Status
- Lightweight status per contact: `status`, `waiting_on`, `next_action`, `notes`, `due_at`
- `GET/POST/PATCH /api/contacts/:id/workflows`

## CLI

```bash
# Install
npm install -g sondex
# or
brew install sondex

# Initialize (creates config + database)
sondex init
# → Prompts for Postgres connection string (or creates local DB)
# → Creates ~/.config/sondex/config.json
# → Runs migrations

# Start server
sondex start
# → Starts on http://localhost:3200 (configurable)
# → Logs to stdout

# Run migrations
sondex migrate

# Check status
sondex status
# → Shows: server URL, DB connection, contact count, last webhook received

# Import from hosted Sondex (future)
sondex import --from https://sondex.vercel.app --api-key sk_...
```

## Config File (`~/.config/sondex/config.json`)

```json
{
  "port": 3200,
  "database_url": "postgresql://localhost:5432/sondex",
  "anthropic_api_key": "sk-ant-...",
  "agentmail": {
    "api_key": "am_...",
    "inbox": "you@yourdomain.co",
    "webhook_secret": "whsec_..."
  },
  "stripe": {
    "api_key": "sk_live_...",
    "webhook_secret": "whsec_..."
  },
  "openclaw_webhook_url": "http://localhost:4440/api/system-event"
}
```

## Database Schema

Use Drizzle ORM with the following tables (mirror the hosted Sondex schema):

```
contacts
  id uuid PK
  name text
  email text (unique)
  email_aliases text[]
  company text
  phone text
  source text
  summary text
  tags text[]
  metadata jsonb
  created_at timestamptz
  updated_at timestamptz

interactions
  id uuid PK
  contact_id uuid FK → contacts
  channel text (email, chat, etc.)
  direction text (inbound, outbound)
  subject text
  body text
  metadata jsonb
  created_at timestamptz

payments
  id uuid PK
  contact_id uuid FK → contacts
  amount_cents integer
  currency text
  status text
  description text
  stripe_payment_intent_id text
  metadata jsonb
  created_at timestamptz

relationship_workflows
  id uuid PK
  contact_id uuid FK → contacts
  kind text
  status text
  waiting_on text
  next_action text
  notes text
  due_at timestamptz
  updated_at timestamptz
```

## Docker Support

```yaml
# docker-compose.yml
services:
  sondex:
    image: ghcr.io/nateliason/sondex-oss:latest
    ports:
      - "3200:3200"
    environment:
      - DATABASE_URL=postgresql://postgres:postgres@db:5432/sondex
    depends_on:
      - db
  db:
    image: postgres:16
    volumes:
      - sondex_data:/var/lib/postgresql/data
    environment:
      - POSTGRES_DB=sondex
      - POSTGRES_PASSWORD=postgres
volumes:
  sondex_data:
```

## OpenClaw Integration

Include an OpenClaw skill in the repo at `openclaw-skill/SKILL.md` that:
1. Tells the agent about the local Sondex instance
2. Shows how to query context before replying to emails
3. Provides the webhook URL to configure in OpenClaw

Example skill usage:
```
Before replying to any email, query Sondex for context:
curl -s http://localhost:3200/api/v1/context/person@email.com
```

## What NOT to Include
- No web UI (dashboard, settings page, landing page) — that's the hosted version's value-add
- No Supabase dependency
- No multi-user auth
- No Vercel/serverless patterns

## Success Criteria
- `sondex init && sondex start` works on macOS and Linux
- Context API returns useful data after email webhook fires
- Docker compose brings up the full stack in one command
- README is clear enough that an OpenClaw user can set it up in 10 minutes

## README Structure
1. What is Sondex (one paragraph)
2. Quick start (npm install + init + start)
3. Docker quick start
4. Configuration reference
5. API reference (all endpoints)
6. OpenClaw integration guide
7. Contributing
