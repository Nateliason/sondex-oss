import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  uniqueIndex
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailAliases: text('email_aliases').array().notNull().default(sql`'{}'::text[]`),
    company: text('company'),
    phone: text('phone'),
    source: text('source').default('manual').notNull(),
    summary: text('summary'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => ({
    contactsEmailUniqueIdx: uniqueIndex('contacts_email_unique_idx').on(table.email)
  })
);

export const interactions = pgTable('interactions', {
  id: uuid('id').defaultRandom().primaryKey(),
  contactId: uuid('contact_id')
    .references(() => contacts.id, { onDelete: 'cascade' })
    .notNull(),
  channel: text('channel').notNull(),
  direction: text('direction').notNull(),
  subject: text('subject'),
  body: text('body'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export const payments = pgTable('payments', {
  id: uuid('id').defaultRandom().primaryKey(),
  contactId: uuid('contact_id')
    .references(() => contacts.id, { onDelete: 'cascade' })
    .notNull(),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('usd'),
  status: text('status').notNull(),
  description: text('description'),
  stripePaymentIntentId: text('stripe_payment_intent_id'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export const relationshipWorkflows = pgTable('relationship_workflows', {
  id: uuid('id').defaultRandom().primaryKey(),
  contactId: uuid('contact_id')
    .references(() => contacts.id, { onDelete: 'cascade' })
    .notNull(),
  kind: text('kind').notNull().default('relationship'),
  status: text('status').notNull(),
  waitingOn: text('waiting_on'),
  nextAction: text('next_action'),
  notes: text('notes'),
  dueAt: timestamp('due_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
});
