import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { contacts, interactions, payments, relationshipWorkflows } from './db/schema.js';
import { compactInteraction, generateSummary } from './services/summarize.js';
import { getEnabledEmailSources } from './services/email-sync.js';

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const createContactSchema = z.object({
  name: z.string().trim().min(1),
  email: z.string().email(),
  company: z.string().trim().optional().nullable(),
  phone: z.string().trim().optional().nullable(),
  source: z.string().trim().optional().default('manual'),
  summary: z.string().trim().optional().nullable(),
  tags: z.array(z.string()).optional().default([]),
  email_aliases: z.array(z.string().email()).optional().default([]),
  metadata: z.record(z.string(), z.any()).optional().default({})
});

const updateContactSchema = createContactSchema.partial();

const mergeContactSchema = z.object({
  merge_contact_id: z.string().uuid()
});

const workflowSchema = z.object({
  kind: z.string().trim().default('relationship'),
  status: z.string().trim().min(1),
  waiting_on: z.string().trim().optional().nullable(),
  next_action: z.string().trim().optional().nullable(),
  notes: z.string().trim().optional().nullable(),
  due_at: z.string().datetime().optional().nullable()
});

const workflowPatchSchema = workflowSchema
  .partial()
  .extend({
    id: z.string().uuid()
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: 'Patch requires at least one field besides id.'
  });

function validateWebhookSecret(req, configuredSecret) {
  if (!configuredSecret) {
    return true;
  }

  const provided =
    req.header('x-webhook-secret') ?? req.header('x-sondex-webhook-secret') ?? req.header('stripe-signature');

  return provided === configuredSecret;
}

function isUuid(value) {
  return uuidRegex.test(value);
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean).map((entry) => entry.trim()).filter(Boolean))];
}

async function fetchContactByIdentifier(db, identifier) {
  if (isUuid(identifier)) {
    const [contact] = await db.select().from(contacts).where(eq(contacts.id, identifier)).limit(1);
    if (contact) {
      return { contact, matchedBy: 'id' };
    }
  }

  const lowered = identifier.toLowerCase();
  const [direct] = await db
    .select()
    .from(contacts)
    .where(sql`lower(${contacts.email}) = ${lowered}`)
    .limit(1);

  if (direct) {
    return { contact: direct, matchedBy: 'email' };
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

  if (alias) {
    return { contact: alias, matchedBy: 'alias' };
  }

  return null;
}

export function createApp({ db, config, emailSync = null }) {
  const app = new Hono();

  app.get('/', (c) =>
    c.json({
      name: 'sondex-oss',
      status: 'ok',
      port: config.port,
      email_sources: getEnabledEmailSources(config),
      docs: '/api/contacts'
    })
  );

  app.get('/api/contacts', async (c) => {
    const search = c.req.query('search')?.trim();

    const result = await db
      .select()
      .from(contacts)
      .where(
        search
          ? or(
              ilike(contacts.name, `%${search}%`),
              ilike(contacts.email, `%${search}%`),
              sql`EXISTS (
                SELECT 1
                FROM unnest(${contacts.emailAliases}) AS alias
                WHERE lower(alias) = ${search.toLowerCase()}
              )`
            )
          : undefined
      )
      .orderBy(desc(contacts.updatedAt))
      .limit(200);

    return c.json({ data: result });
  });

  app.post('/api/contacts', async (c) => {
    const payload = await c.req.json();
    const parsed = createContactSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const data = parsed.data;

    const [created] = await db
      .insert(contacts)
      .values({
        name: data.name,
        email: data.email.toLowerCase(),
        company: data.company ?? null,
        phone: data.phone ?? null,
        source: data.source,
        summary: data.summary ?? null,
        tags: dedupeStrings(data.tags),
        emailAliases: dedupeStrings(data.email_aliases.map((entry) => entry.toLowerCase())),
        metadata: data.metadata,
        updatedAt: new Date()
      })
      .returning();

    return c.json({ data: created }, 201);
  });

  app.get('/api/contacts/:id', async (c) => {
    const contactId = c.req.param('id');
    const [contact] = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);

    if (!contact) {
      return c.json({ error: 'Contact not found' }, 404);
    }

    return c.json({ data: contact });
  });

  app.patch('/api/contacts/:id', async (c) => {
    const contactId = c.req.param('id');
    const payload = await c.req.json();
    const parsed = updateContactSchema.safeParse(payload);

    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const updates = parsed.data;
    const values = {
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.email !== undefined ? { email: updates.email.toLowerCase() } : {}),
      ...(updates.company !== undefined ? { company: updates.company } : {}),
      ...(updates.phone !== undefined ? { phone: updates.phone } : {}),
      ...(updates.source !== undefined ? { source: updates.source } : {}),
      ...(updates.summary !== undefined ? { summary: updates.summary } : {}),
      ...(updates.tags !== undefined ? { tags: dedupeStrings(updates.tags) } : {}),
      ...(updates.email_aliases !== undefined
        ? { emailAliases: dedupeStrings(updates.email_aliases.map((entry) => entry.toLowerCase())) }
        : {}),
      ...(updates.metadata !== undefined ? { metadata: updates.metadata } : {}),
      updatedAt: new Date()
    };

    const [updated] = await db
      .update(contacts)
      .set(values)
      .where(eq(contacts.id, contactId))
      .returning();

    if (!updated) {
      return c.json({ error: 'Contact not found' }, 404);
    }

    return c.json({ data: updated });
  });

  app.delete('/api/contacts/:id', async (c) => {
    const contactId = c.req.param('id');
    const [deleted] = await db.delete(contacts).where(eq(contacts.id, contactId)).returning();

    if (!deleted) {
      return c.json({ error: 'Contact not found' }, 404);
    }

    return c.json({ ok: true });
  });

  app.get('/api/contacts/:id/interactions', async (c) => {
    const contactId = c.req.param('id');
    const rows = await db
      .select()
      .from(interactions)
      .where(eq(interactions.contactId, contactId))
      .orderBy(desc(interactions.createdAt));

    return c.json({ data: rows });
  });

  app.get('/api/contacts/:id/payments', async (c) => {
    const contactId = c.req.param('id');
    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.contactId, contactId))
      .orderBy(desc(payments.createdAt));

    return c.json({ data: rows });
  });

  app.post('/api/contacts/:id/summarize', async (c) => {
    const contactId = c.req.param('id');

    const [contact] = await db.select().from(contacts).where(eq(contacts.id, contactId)).limit(1);
    if (!contact) {
      return c.json({ error: 'Contact not found' }, 404);
    }

    const recentInteractions = await db
      .select()
      .from(interactions)
      .where(eq(interactions.contactId, contactId))
      .orderBy(desc(interactions.createdAt))
      .limit(25);

    const contactPayments = await db
      .select()
      .from(payments)
      .where(eq(payments.contactId, contactId))
      .orderBy(desc(payments.createdAt))
      .limit(25);

    const workflows = await db
      .select()
      .from(relationshipWorkflows)
      .where(eq(relationshipWorkflows.contactId, contactId))
      .orderBy(desc(relationshipWorkflows.updatedAt));

    const summary = await generateSummary(config, contact, recentInteractions, contactPayments, workflows);

    const [updated] = await db
      .update(contacts)
      .set({
        summary,
        updatedAt: new Date()
      })
      .where(eq(contacts.id, contactId))
      .returning();

    return c.json({ data: updated });
  });

  app.post('/api/contacts/:id/merge', async (c) => {
    const primaryId = c.req.param('id');
    const payload = await c.req.json();
    const parsed = mergeContactSchema.safeParse(payload);

    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const mergeId = parsed.data.merge_contact_id;

    if (primaryId === mergeId) {
      return c.json({ error: 'Cannot merge the same contact.' }, 400);
    }

    const [primary] = await db.select().from(contacts).where(eq(contacts.id, primaryId)).limit(1);
    const [secondary] = await db.select().from(contacts).where(eq(contacts.id, mergeId)).limit(1);

    if (!primary || !secondary) {
      return c.json({ error: 'Both contacts must exist.' }, 404);
    }

    await db.update(interactions).set({ contactId: primary.id }).where(eq(interactions.contactId, secondary.id));
    await db.update(payments).set({ contactId: primary.id }).where(eq(payments.contactId, secondary.id));
    await db
      .update(relationshipWorkflows)
      .set({ contactId: primary.id, updatedAt: new Date() })
      .where(eq(relationshipWorkflows.contactId, secondary.id));

    const aliases = dedupeStrings([
      ...(primary.emailAliases ?? []),
      ...(secondary.emailAliases ?? []),
      secondary.email
    ]);

    const tags = dedupeStrings([...(primary.tags ?? []), ...(secondary.tags ?? [])]);

    const [updatedPrimary] = await db
      .update(contacts)
      .set({
        emailAliases: aliases,
        tags,
        summary: primary.summary ?? secondary.summary,
        updatedAt: new Date()
      })
      .where(eq(contacts.id, primary.id))
      .returning();

    await db.delete(contacts).where(eq(contacts.id, secondary.id));

    return c.json({
      data: updatedPrimary,
      merged_contact_id: secondary.id
    });
  });

  app.get('/api/contacts/:id/workflows', async (c) => {
    const contactId = c.req.param('id');
    const rows = await db
      .select()
      .from(relationshipWorkflows)
      .where(eq(relationshipWorkflows.contactId, contactId))
      .orderBy(desc(relationshipWorkflows.updatedAt));

    return c.json({ data: rows });
  });

  app.post('/api/contacts/:id/workflows', async (c) => {
    const contactId = c.req.param('id');
    const payload = await c.req.json();
    const parsed = workflowSchema.safeParse(payload);

    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const workflow = parsed.data;

    const [created] = await db
      .insert(relationshipWorkflows)
      .values({
        contactId,
        kind: workflow.kind,
        status: workflow.status,
        waitingOn: workflow.waiting_on ?? null,
        nextAction: workflow.next_action ?? null,
        notes: workflow.notes ?? null,
        dueAt: workflow.due_at ? new Date(workflow.due_at) : null,
        updatedAt: new Date()
      })
      .returning();

    return c.json({ data: created }, 201);
  });

  app.patch('/api/contacts/:id/workflows', async (c) => {
    const contactId = c.req.param('id');
    const payload = await c.req.json();
    const parsed = workflowPatchSchema.safeParse(payload);

    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const workflow = parsed.data;

    const [updated] = await db
      .update(relationshipWorkflows)
      .set({
        ...(workflow.kind !== undefined ? { kind: workflow.kind } : {}),
        ...(workflow.status !== undefined ? { status: workflow.status } : {}),
        ...(workflow.waiting_on !== undefined ? { waitingOn: workflow.waiting_on } : {}),
        ...(workflow.next_action !== undefined ? { nextAction: workflow.next_action } : {}),
        ...(workflow.notes !== undefined ? { notes: workflow.notes } : {}),
        ...(workflow.due_at !== undefined ? { dueAt: workflow.due_at ? new Date(workflow.due_at) : null } : {}),
        updatedAt: new Date()
      })
      .where(and(eq(relationshipWorkflows.id, workflow.id), eq(relationshipWorkflows.contactId, contactId)))
      .returning();

    if (!updated) {
      return c.json({ error: 'Workflow not found for contact.' }, 404);
    }

    return c.json({ data: updated });
  });

  app.get('/api/v1/context/:identifier', async (c) => {
    const identifier = c.req.param('identifier').trim();
    const lookup = await fetchContactByIdentifier(db, identifier);

    if (!lookup) {
      return c.json({ error: 'contact_not_found', identifier }, 404);
    }

    const { contact, matchedBy } = lookup;

    const contactInteractions = await db
      .select()
      .from(interactions)
      .where(eq(interactions.contactId, contact.id))
      .orderBy(desc(interactions.createdAt))
      .limit(10);

    const contactPayments = await db
      .select()
      .from(payments)
      .where(eq(payments.contactId, contact.id))
      .orderBy(desc(payments.createdAt))
      .limit(10);

    const workflows = await db
      .select()
      .from(relationshipWorkflows)
      .where(eq(relationshipWorkflows.contactId, contact.id))
      .orderBy(desc(relationshipWorkflows.updatedAt))
      .limit(3);

    const openWorkflow = workflows.find((workflow) => workflow.status !== 'done') ?? workflows[0] ?? null;
    const totalPaidCents = contactPayments.reduce((total, payment) => total + Number(payment.amountCents || 0), 0);

    return c.json({
      contact: {
        id: contact.id,
        name: contact.name,
        email: contact.email,
        aliases: contact.emailAliases,
        company: contact.company,
        tags: contact.tags,
        summary: contact.summary
      },
      relationship: openWorkflow
        ? {
            status: openWorkflow.status,
            waiting_on: openWorkflow.waitingOn,
            next_action: openWorkflow.nextAction,
            due_at: openWorkflow.dueAt,
            notes: openWorkflow.notes
          }
        : null,
      recent_interactions: contactInteractions.map(compactInteraction),
      payment_history: {
        count: contactPayments.length,
        total_cents: totalPaidCents,
        last_payment_at: contactPayments[0]?.createdAt ?? null,
        recent: contactPayments.map((payment) => ({
          at: payment.createdAt,
          amount_cents: payment.amountCents,
          currency: payment.currency,
          status: payment.status,
          description: payment.description
        }))
      },
      lookup: {
        identifier,
        matched_by: matchedBy
      }
    });
  });

  app.post('/api/sync/gmail', async (c) => {
    if (!emailSync) {
      return c.json({ error: 'Email sync service unavailable.' }, 503);
    }

    const result = await emailSync.syncGmail();
    if (result.disabled) {
      return c.json(
        {
          error: 'Gmail is not configured. Set gmail.client_id, gmail.client_secret, and gmail.refresh_token.'
        },
        400
      );
    }

    return c.json({ ok: true, ...result });
  });

  app.post('/api/sync/imap', async (c) => {
    if (!emailSync) {
      return c.json({ error: 'Email sync service unavailable.' }, 503);
    }

    const result = await emailSync.syncImap();
    if (result.disabled) {
      return c.json(
        {
          error: 'IMAP is not configured. Set imap.host, imap.port, imap.user, imap.password, and imap.tls.'
        },
        400
      );
    }

    return c.json({ ok: true, ...result });
  });

  app.post('/api/webhooks/agentmail', async (c) => {
    if (!validateWebhookSecret(c.req, config.agentmail.webhook_secret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const payload = await c.req.json();
    const from = String(payload.from_email ?? payload.from ?? '').trim().toLowerCase();
    const name = String(payload.from_name ?? payload.name ?? from.split('@')[0] ?? 'Unknown').trim();

    if (!from || !from.includes('@')) {
      return c.json({ error: 'Missing sender email' }, 400);
    }

    let lookup = await fetchContactByIdentifier(db, from);

    if (!lookup) {
      const [created] = await db
        .insert(contacts)
        .values({
          name,
          email: from,
          source: 'agentmail',
          metadata: payload.contact_metadata ?? {},
          updatedAt: new Date()
        })
        .returning();

      lookup = {
        contact: created,
        matchedBy: 'email'
      };
    }

    const [createdInteraction] = await db
      .insert(interactions)
      .values({
        contactId: lookup.contact.id,
        channel: 'email',
        direction: 'inbound',
        subject: payload.subject ? String(payload.subject) : null,
        body: String(payload.body_text ?? payload.body ?? payload.body_html ?? ''),
        metadata: payload,
        createdAt: payload.timestamp ? new Date(payload.timestamp) : new Date()
      })
      .returning();

    await db
      .update(contacts)
      .set({
        updatedAt: new Date()
      })
      .where(eq(contacts.id, lookup.contact.id));

    return c.json({
      ok: true,
      contact_id: lookup.contact.id,
      interaction_id: createdInteraction.id
    });
  });

  app.post('/api/webhooks/stripe', async (c) => {
    if (!validateWebhookSecret(c.req, config.stripe.webhook_secret)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const payload = await c.req.json();
    const eventType = String(payload.type ?? '').trim();
    const obj = payload.data?.object ?? payload;

    const email = String(
      obj.customer_email ?? obj.receipt_email ?? obj.billing_details?.email ?? obj.charges?.data?.[0]?.billing_details?.email ?? ''
    )
      .trim()
      .toLowerCase();

    if (!email) {
      return c.json({ ok: true, ignored: true, reason: 'No customer email in event.' });
    }

    let lookup = await fetchContactByIdentifier(db, email);

    if (!lookup) {
      const [created] = await db
        .insert(contacts)
        .values({
          name: email.split('@')[0],
          email,
          source: 'stripe',
          metadata: { stripe_customer_id: obj.customer ?? null },
          updatedAt: new Date()
        })
        .returning();

      lookup = {
        contact: created,
        matchedBy: 'email'
      };
    }

    const amount = Number(obj.amount_received ?? obj.amount ?? 0);
    const currency = String(obj.currency ?? 'usd').toLowerCase();
    const status = String(obj.status ?? (eventType.includes('failed') ? 'failed' : 'succeeded')).toLowerCase();

    const [createdPayment] = await db
      .insert(payments)
      .values({
        contactId: lookup.contact.id,
        amountCents: Number.isFinite(amount) ? amount : 0,
        currency,
        status,
        description: obj.description ?? eventType,
        stripePaymentIntentId: obj.payment_intent ?? obj.id ?? null,
        metadata: payload,
        createdAt: obj.created ? new Date(Number(obj.created) * 1000) : new Date()
      })
      .returning();

    await db
      .update(contacts)
      .set({
        updatedAt: new Date()
      })
      .where(eq(contacts.id, lookup.contact.id));

    return c.json({
      ok: true,
      contact_id: lookup.contact.id,
      payment_id: createdPayment.id
    });
  });

  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: 'Internal server error', message: error.message }, 500);
  });

  return app;
}
