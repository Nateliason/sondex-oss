import { and, eq, sql } from 'drizzle-orm';
import { google } from 'googleapis';
import { ImapFlow } from 'imapflow';
import { contacts, interactions } from '../db/schema.js';

const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_GMAIL_MESSAGES_PER_SYNC = 200;
const MAX_IMAP_MESSAGES_PER_SYNC = 200;
const MAX_BODY_LENGTH = 20_000;

function normalizeEmail(value) {
  if (!value) {
    return '';
  }

  return String(value).trim().toLowerCase();
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function dedupeAddresses(addresses) {
  const seen = new Set();
  const result = [];

  for (const address of addresses) {
    if (!address?.email || seen.has(address.email)) {
      continue;
    }

    seen.add(address.email);
    result.push(address);
  }

  return result;
}

function parseAddressToken(token) {
  const trimmed = String(token ?? '').trim();
  if (!trimmed) {
    return null;
  }

  const named = trimmed.match(/^(?:"?([^"]*)"?\s*)?<([^<>]+@[^<>]+)>$/);
  if (named) {
    return {
      name: String(named[1] ?? '').trim(),
      email: normalizeEmail(named[2])
    };
  }

  const direct = trimmed.match(/([^\s,;<>]+@[^\s,;<>]+)/);
  if (!direct) {
    return null;
  }

  return {
    name: '',
    email: normalizeEmail(direct[1])
  };
}

function parseAddressList(value) {
  if (!value) {
    return [];
  }

  const raw = Array.isArray(value) ? value.join(',') : String(value);
  const chunks = raw
    .split(',')
    .map((entry) => parseAddressToken(entry))
    .filter((entry) => entry?.email);

  return dedupeAddresses(chunks);
}

function parseEnvelopeAddresses(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return dedupeAddresses(
    entries
      .map((entry) => ({
        name: String(entry?.name ?? '').trim(),
        email: normalizeEmail(entry?.address)
      }))
      .filter((entry) => entry.email)
  );
}

function headerValue(headers, key) {
  return headers.find((entry) => entry?.name?.toLowerCase() === key)?.value ?? '';
}

function decodeBase64Url(value) {
  if (!value) {
    return '';
  }

  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = `${normalized}${'='.repeat((4 - (normalized.length % 4)) % 4)}`;
  return Buffer.from(padded, 'base64').toString('utf8');
}

function stripHtml(value) {
  return String(value ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractGmailBody(payload, snippet) {
  const parts = [];

  const walk = (part) => {
    if (!part) {
      return;
    }

    if (part.body?.data) {
      parts.push({
        mimeType: String(part.mimeType ?? ''),
        value: decodeBase64Url(part.body.data)
      });
    }

    for (const child of part.parts ?? []) {
      walk(child);
    }
  };

  walk(payload);

  const plain = parts.find((entry) => entry.mimeType.includes('text/plain'))?.value;
  if (plain?.trim()) {
    return plain.slice(0, MAX_BODY_LENGTH);
  }

  const html = parts.find((entry) => entry.mimeType.includes('text/html'))?.value;
  if (html?.trim()) {
    return stripHtml(html).slice(0, MAX_BODY_LENGTH);
  }

  return String(snippet ?? '').trim().slice(0, MAX_BODY_LENGTH);
}

function extractImapBody(source) {
  if (!source) {
    return '';
  }

  const raw = Buffer.isBuffer(source) ? source.toString('utf8') : String(source);
  const separator = raw.search(/\r?\n\r?\n/);
  if (separator === -1) {
    return raw.slice(0, MAX_BODY_LENGTH);
  }

  return raw.slice(separator).replace(/^\r?\n\r?\n/, '').slice(0, MAX_BODY_LENGTH);
}

function normalizeMessageId(value, fallback = '') {
  return String(value ?? fallback).trim().replace(/^<|>$/g, '');
}

function inferDirection({ from, recipients, ownEmails }) {
  const fromIsOwn = from?.email && ownEmails.has(from.email);
  const hasOwnRecipient = recipients.some((entry) => ownEmails.has(entry.email));

  if (fromIsOwn && recipients.some((entry) => !ownEmails.has(entry.email))) {
    return 'outbound';
  }

  if (!fromIsOwn && hasOwnRecipient) {
    return 'inbound';
  }

  return fromIsOwn ? 'outbound' : 'inbound';
}

function pickCounterparty({ direction, from, recipients, ownEmails }) {
  if (direction === 'outbound') {
    return recipients.find((entry) => !ownEmails.has(entry.email)) ?? from ?? null;
  }

  if (from?.email && !ownEmails.has(from.email)) {
    return from;
  }

  return recipients.find((entry) => !ownEmails.has(entry.email)) ?? null;
}

function fallbackName(email) {
  return email.split('@')[0] || 'Unknown';
}

async function findContactByEmail(db, email) {
  const lowered = normalizeEmail(email);
  if (!lowered) {
    return null;
  }

  const [direct] = await db
    .select()
    .from(contacts)
    .where(sql`lower(${contacts.email}) = ${lowered}`)
    .limit(1);

  if (direct) {
    return direct;
  }

  const [alias] = await db
    .select()
    .from(contacts)
    .where(
      sql`EXISTS (
        SELECT 1
        FROM unnest(${contacts.emailAliases}) AS alias
        WHERE lower(alias) = ${lowered}
      )`
    )
    .limit(1);

  return alias ?? null;
}

async function upsertContact(db, { email, name, source, metadata }) {
  const lowered = normalizeEmail(email);
  if (!lowered) {
    return { contact: null, created: false };
  }

  const existing = await findContactByEmail(db, lowered);

  if (!existing) {
    const [created] = await db
      .insert(contacts)
      .values({
        name: String(name ?? '').trim() || fallbackName(lowered),
        email: lowered,
        source,
        metadata: metadata ?? {},
        updatedAt: new Date()
      })
      .returning();

    return { contact: created, created: true };
  }

  const aliases = dedupeStrings([...(existing.emailAliases ?? []), ...(existing.email !== lowered ? [lowered] : [])]);

  const [updated] = await db
    .update(contacts)
    .set({
      emailAliases: aliases,
      updatedAt: new Date()
    })
    .where(eq(contacts.id, existing.id))
    .returning();

  return { contact: updated ?? existing, created: false };
}

async function interactionExists(db, provider, providerMessageId) {
  if (!providerMessageId) {
    return false;
  }

  const [existing] = await db
    .select({ id: interactions.id })
    .from(interactions)
    .where(
      and(
        sql`${interactions.metadata} ->> 'provider' = ${provider}`,
        sql`${interactions.metadata} ->> 'provider_message_id' = ${providerMessageId}`
      )
    )
    .limit(1);

  return Boolean(existing?.id);
}

async function getLastProviderTimestampMs(db, provider) {
  const result = await db.execute(
    sql`SELECT MAX(created_at) AS ts FROM interactions WHERE metadata ->> 'provider' = ${provider}`
  );

  const row = result?.rows?.[0] ?? result?.[0] ?? null;
  const raw = row?.ts;
  if (!raw) {
    return null;
  }

  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

async function ingestEmailMessage(db, payload) {
  const {
    provider,
    providerMessageId,
    providerThreadId,
    createdAt,
    subject,
    body,
    from,
    recipients,
    ownEmails,
    rawMetadata
  } = payload;

  if (!providerMessageId) {
    return { created_contact: false, created_interaction: false, skipped: 'missing_message_id' };
  }

  if (await interactionExists(db, provider, providerMessageId)) {
    return { created_contact: false, created_interaction: false, skipped: 'duplicate' };
  }

  const direction = inferDirection({ from, recipients, ownEmails });
  const counterparty = pickCounterparty({ direction, from, recipients, ownEmails });

  if (!counterparty?.email) {
    return { created_contact: false, created_interaction: false, skipped: 'missing_counterparty' };
  }

  const { contact, created } = await upsertContact(db, {
    email: counterparty.email,
    name: counterparty.name,
    source: provider,
    metadata: { provider }
  });

  if (!contact?.id) {
    return { created_contact: false, created_interaction: false, skipped: 'missing_contact' };
  }

  await db.insert(interactions).values({
    contactId: contact.id,
    channel: 'email',
    direction,
    subject: subject ? String(subject).slice(0, 500) : null,
    body: body ? String(body).slice(0, MAX_BODY_LENGTH) : null,
    metadata: {
      provider,
      provider_message_id: providerMessageId,
      provider_thread_id: providerThreadId ?? null,
      from,
      recipients,
      raw: rawMetadata ?? {}
    },
    createdAt: createdAt ?? new Date()
  });

  await db
    .update(contacts)
    .set({ updatedAt: new Date() })
    .where(eq(contacts.id, contact.id));

  return { created_contact: created, created_interaction: true, skipped: null };
}

function getOwnEmails(config, extra = []) {
  return new Set(
    dedupeStrings([
      normalizeEmail(config.agentmail?.inbox),
      normalizeEmail(config.imap?.user),
      ...extra.map((value) => normalizeEmail(value))
    ])
  );
}

function pollIntervalMs(seconds, fallbackMs) {
  const parsed = Number(seconds);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackMs;
  }

  return parsed * 1000;
}

export function isGmailConfigured(config) {
  return Boolean(config.gmail?.client_id && config.gmail?.client_secret && config.gmail?.refresh_token);
}

export function isImapConfigured(config) {
  return Boolean(config.imap?.host && config.imap?.user && config.imap?.password);
}

export function getEnabledEmailSources(config) {
  const enabled = [];
  if (isGmailConfigured(config)) {
    enabled.push('gmail');
  }
  if (isImapConfigured(config)) {
    enabled.push('imap');
  }
  return enabled;
}

async function syncGmailInternal({ db, config, state }) {
  const auth = new google.auth.OAuth2(config.gmail.client_id, config.gmail.client_secret);
  auth.setCredentials({ refresh_token: config.gmail.refresh_token });

  const gmail = google.gmail({ version: 'v1', auth });

  const profile = await gmail.users.getProfile({ userId: 'me' });
  const ownEmails = getOwnEmails(config, [profile.data?.emailAddress]);

  if (!state.lastTimestampMs) {
    state.lastTimestampMs = (await getLastProviderTimestampMs(db, 'gmail')) ?? Date.now() - LOOKBACK_MS;
  }

  const queryAfter = Math.max(state.lastTimestampMs - 60_000, Date.now() - LOOKBACK_MS);
  const q = `after:${Math.floor(queryAfter / 1000)}`;

  let pageToken;
  let scanned = 0;
  let createdContacts = 0;
  let createdInteractions = 0;
  let duplicates = 0;
  let skipped = 0;
  let errors = 0;
  let newestTimestamp = state.lastTimestampMs;

  do {
    const listed = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: 100,
      pageToken
    });

    const messages = [...(listed.data.messages ?? [])].reverse();
    for (const message of messages) {
      if (scanned >= MAX_GMAIL_MESSAGES_PER_SYNC) {
        break;
      }

      scanned += 1;

      try {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id: message.id,
          format: 'full'
        });

        const headers = detail.data.payload?.headers ?? [];
        const from = parseAddressList(headerValue(headers, 'from'))[0] ?? null;
        const recipients = dedupeAddresses([
          ...parseAddressList(headerValue(headers, 'to')),
          ...parseAddressList(headerValue(headers, 'cc')),
          ...parseAddressList(headerValue(headers, 'bcc'))
        ]);

        const createdAt = detail.data.internalDate
          ? new Date(Number(detail.data.internalDate))
          : new Date(headerValue(headers, 'date') || Date.now());
        const createdAtMs = createdAt.getTime();
        if (Number.isFinite(createdAtMs)) {
          newestTimestamp = Math.max(newestTimestamp, createdAtMs);
        }

        const result = await ingestEmailMessage(db, {
          provider: 'gmail',
          providerMessageId: normalizeMessageId(detail.data.id, message.id),
          providerThreadId: normalizeMessageId(detail.data.threadId),
          createdAt,
          subject: headerValue(headers, 'subject') || detail.data.snippet || '',
          body: extractGmailBody(detail.data.payload, detail.data.snippet),
          from,
          recipients,
          ownEmails,
          rawMetadata: {
            labels: detail.data.labelIds ?? [],
            history_id: detail.data.historyId ?? null
          }
        });

        if (result.created_contact) {
          createdContacts += 1;
        }
        if (result.created_interaction) {
          createdInteractions += 1;
        } else if (result.skipped === 'duplicate') {
          duplicates += 1;
        } else {
          skipped += 1;
        }
      } catch (error) {
        errors += 1;
      }
    }

    pageToken = listed.data.nextPageToken;
  } while (pageToken && scanned < MAX_GMAIL_MESSAGES_PER_SYNC);

  state.lastTimestampMs = newestTimestamp;

  return {
    source: 'gmail',
    scanned,
    created_contacts: createdContacts,
    created_interactions: createdInteractions,
    duplicates,
    skipped,
    errors
  };
}

async function syncImapInternal({ db, config, state }) {
  const client = new ImapFlow({
    host: config.imap.host,
    port: Number(config.imap.port ?? 993),
    secure: config.imap.tls !== false,
    auth: {
      user: config.imap.user,
      pass: config.imap.password
    },
    logger: false
  });

  if (!state.lastTimestampMs) {
    state.lastTimestampMs = (await getLastProviderTimestampMs(db, 'imap')) ?? Date.now() - LOOKBACK_MS;
  }

  const ownEmails = getOwnEmails(config, [config.imap.user]);

  let scanned = 0;
  let createdContacts = 0;
  let createdInteractions = 0;
  let duplicates = 0;
  let skipped = 0;
  let errors = 0;
  let newestTimestamp = state.lastTimestampMs;

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  try {
    const since = new Date(Math.max(state.lastTimestampMs - 60_000, Date.now() - LOOKBACK_MS));
    const uids = await client.search({ since });
    const queue = [...uids].sort((a, b) => a - b).slice(-MAX_IMAP_MESSAGES_PER_SYNC);

    if (!queue.length) {
      return {
        source: 'imap',
        scanned,
        created_contacts: createdContacts,
        created_interactions: createdInteractions,
        duplicates,
        skipped,
        errors
      };
    }

    for await (const message of client.fetch(queue, {
      uid: true,
      envelope: true,
      source: true,
      internalDate: true
    })) {
      scanned += 1;

      try {
        const from = parseEnvelopeAddresses(message.envelope?.from)[0] ?? null;
        const recipients = dedupeAddresses([
          ...parseEnvelopeAddresses(message.envelope?.to),
          ...parseEnvelopeAddresses(message.envelope?.cc),
          ...parseEnvelopeAddresses(message.envelope?.bcc)
        ]);

        const createdAt = message.internalDate ? new Date(message.internalDate) : new Date();
        const createdAtMs = createdAt.getTime();
        if (Number.isFinite(createdAtMs)) {
          newestTimestamp = Math.max(newestTimestamp, createdAtMs);
        }

        const providerMessageId = normalizeMessageId(message.envelope?.messageId, `uid-${message.uid}`);

        const result = await ingestEmailMessage(db, {
          provider: 'imap',
          providerMessageId,
          providerThreadId: null,
          createdAt,
          subject: message.envelope?.subject ?? '',
          body: extractImapBody(message.source),
          from,
          recipients,
          ownEmails,
          rawMetadata: {
            mailbox: 'INBOX',
            uid: message.uid
          }
        });

        if (result.created_contact) {
          createdContacts += 1;
        }
        if (result.created_interaction) {
          createdInteractions += 1;
        } else if (result.skipped === 'duplicate') {
          duplicates += 1;
        } else {
          skipped += 1;
        }
      } catch (error) {
        errors += 1;
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }

  state.lastTimestampMs = newestTimestamp;

  return {
    source: 'imap',
    scanned,
    created_contacts: createdContacts,
    created_interactions: createdInteractions,
    duplicates,
    skipped,
    errors
  };
}

export function createEmailSync({ db, config, logger = console }) {
  const state = {
    gmail: {
      running: false,
      lastTimestampMs: null
    },
    imap: {
      running: false,
      lastTimestampMs: null
    }
  };

  let started = false;
  const timers = [];

  const runLocked = async (source, fn) => {
    if (state[source].running) {
      return {
        source,
        scanned: 0,
        created_contacts: 0,
        created_interactions: 0,
        duplicates: 0,
        skipped: 0,
        errors: 0,
        in_progress: true
      };
    }

    state[source].running = true;
    try {
      return await fn();
    } finally {
      state[source].running = false;
    }
  };

  const syncGmail = async () => {
    if (!isGmailConfigured(config)) {
      return {
        source: 'gmail',
        scanned: 0,
        created_contacts: 0,
        created_interactions: 0,
        duplicates: 0,
        skipped: 0,
        errors: 0,
        disabled: true
      };
    }

    return runLocked('gmail', () => syncGmailInternal({ db, config, state: state.gmail }));
  };

  const syncImap = async () => {
    if (!isImapConfigured(config)) {
      return {
        source: 'imap',
        scanned: 0,
        created_contacts: 0,
        created_interactions: 0,
        duplicates: 0,
        skipped: 0,
        errors: 0,
        disabled: true
      };
    }

    return runLocked('imap', () => syncImapInternal({ db, config, state: state.imap }));
  };

  const start = () => {
    if (started) {
      return;
    }

    started = true;

    if (isGmailConfigured(config)) {
      const intervalMs = pollIntervalMs(config.gmail.poll_interval_seconds, 300_000);
      const tick = () =>
        syncGmail().catch((error) => {
          logger.error?.('gmail sync failed', error);
        });

      tick();
      timers.push(setInterval(tick, intervalMs));
    }

    if (isImapConfigured(config)) {
      const intervalMs = pollIntervalMs(config.imap.poll_interval_seconds, 300_000);
      const tick = () =>
        syncImap().catch((error) => {
          logger.error?.('imap sync failed', error);
        });

      tick();
      timers.push(setInterval(tick, intervalMs));
    }
  };

  const stop = () => {
    for (const timer of timers) {
      clearInterval(timer);
    }

    timers.length = 0;
    started = false;
  };

  return {
    syncGmail,
    syncImap,
    start,
    stop,
    getEnabledSources: () => getEnabledEmailSources(config)
  };
}
