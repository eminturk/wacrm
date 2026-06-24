// ============================================================
// Drizzle schema — mirrors the SQL migrations under
// supabase/migrations. This is the single source of truth for the
// app's table shapes after the migration off Supabase/PostgREST to
// plain PostgreSQL + Drizzle.
//
// Conventions:
//  - UUID primary keys default to gen_random_uuid() (pgcrypto, always
//    available on modern Postgres) so we don't depend on uuid-ossp.
//  - TIMESTAMPTZ columns use `withTimezone: true`.
//  - JSONB columns are typed loosely; the app layer narrows them.
// ============================================================

import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  jsonb,
  date,
  pgEnum,
  unique,
  index,
} from 'drizzle-orm/pg-core'

// ------------------------------------------------------------
// Enums
// ------------------------------------------------------------
export const accountRoleEnum = pgEnum('account_role_enum', [
  'owner',
  'admin',
  'agent',
  'viewer',
])

// ============================================================
// AUTH — replaces Supabase's auth.users
// ============================================================
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
})

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [index('idx_sessions_user_id').on(t.userId)],
)

// ============================================================
// ACCOUNTS
// ============================================================
export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  ownerUserId: uuid('owner_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  defaultCurrency: text('default_currency').notNull().default('USD'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const accountInvitations = pgTable('account_invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  role: accountRoleEnum('role').notNull(),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
  label: text('label'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),
})

// ============================================================
// PROFILES
// ============================================================
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  fullName: text('full_name').notNull(),
  email: text('email').notNull(),
  avatarUrl: text('avatar_url'),
  role: text('role').default('user'),
  betaFeatures: text('beta_features').array(),
  accountId: uuid('account_id').references(() => accounts.id, {
    onDelete: 'cascade',
  }),
  accountRole: accountRoleEnum('account_role'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

// ============================================================
// CONTACTS
// ============================================================
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').references(() => accounts.id, {
      onDelete: 'cascade',
    }),
    phone: text('phone').notNull(),
    phoneNormalized: text('phone_normalized'),
    name: text('name'),
    email: text('email'),
    company: text('company'),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index('idx_contacts_user_id').on(t.userId),
    index('idx_contacts_phone').on(t.phone),
  ],
)

export const tags = pgTable('tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => accounts.id, {
    onDelete: 'cascade',
  }),
  name: text('name').notNull(),
  color: text('color').notNull().default('#3b82f6'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
})

export const contactTags = pgTable(
  'contact_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique('contact_tags_contact_id_tag_id_key').on(t.contactId, t.tagId),
    index('idx_contact_tags_contact').on(t.contactId),
    index('idx_contact_tags_tag').on(t.tagId),
  ],
)

export const customFields = pgTable('custom_fields', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => accounts.id, {
    onDelete: 'cascade',
  }),
  fieldName: text('field_name').notNull(),
  fieldType: text('field_type').notNull().default('text'),
  fieldOptions: jsonb('field_options'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
})

export const contactCustomValues = pgTable(
  'contact_custom_values',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    customFieldId: uuid('custom_field_id')
      .notNull()
      .references(() => customFields.id, { onDelete: 'cascade' }),
    value: text('value'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique('contact_custom_values_contact_id_custom_field_id_key').on(
      t.contactId,
      t.customFieldId,
    ),
  ],
)

export const contactNotes = pgTable('contact_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  contactId: uuid('contact_id')
    .notNull()
    .references(() => contacts.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => accounts.id, {
    onDelete: 'cascade',
  }),
  noteText: text('note_text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
})

// ============================================================
// CONVERSATIONS & MESSAGES
// ============================================================
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').references(() => accounts.id, {
      onDelete: 'cascade',
    }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('open'),
    assignedAgentId: uuid('assigned_agent_id'),
    lastMessageText: text('last_message_text'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    unreadCount: integer('unread_count').default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index('idx_conversations_user_id').on(t.userId),
    index('idx_conversations_contact_id').on(t.contactId),
  ],
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderType: text('sender_type').notNull(),
    senderId: uuid('sender_id'),
    contentType: text('content_type').notNull().default('text'),
    contentText: text('content_text'),
    mediaUrl: text('media_url'),
    templateName: text('template_name'),
    messageId: text('message_id'),
    status: text('status').notNull().default('sent'),
    replyToMessageId: uuid('reply_to_message_id'),
    interactiveReplyId: text('interactive_reply_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index('idx_messages_conversation').on(t.conversationId),
    index('idx_messages_message_id').on(t.messageId),
  ],
)

export const messageReactions = pgTable(
  'message_reactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id'),
    emoji: text('emoji').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('message_reactions_message_id_actor_type_actor_id_key').on(
      t.messageId,
      t.actorType,
      t.actorId,
    ),
  ],
)

// ============================================================
// WHATSAPP CONFIG & TEMPLATES
// ============================================================
export const whatsappConfig = pgTable('whatsapp_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => accounts.id, {
    onDelete: 'cascade',
  }),
  phoneNumberId: text('phone_number_id').notNull(),
  wabaId: text('waba_id'),
  accessToken: text('access_token').notNull(),
  verifyToken: text('verify_token'),
  status: text('status').notNull().default('disconnected'),
  connectedAt: timestamp('connected_at', { withTimezone: true }),
  registeredAt: timestamp('registered_at', { withTimezone: true }),
  subscribedAppsAt: timestamp('subscribed_apps_at', { withTimezone: true }),
  lastRegistrationError: text('last_registration_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

export const messageTemplates = pgTable('message_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => accounts.id, {
    onDelete: 'cascade',
  }),
  name: text('name').notNull(),
  category: text('category').notNull().default('Marketing'),
  language: text('language').default('en_US'),
  headerType: text('header_type'),
  headerContent: text('header_content'),
  bodyText: text('body_text').notNull(),
  footerText: text('footer_text'),
  buttons: jsonb('buttons'),
  status: text('status').default('DRAFT'),
  sampleValues: jsonb('sample_values'),
  metaTemplateId: text('meta_template_id'),
  rejectionReason: text('rejection_reason'),
  qualityScore: text('quality_score'),
  headerHandle: text('header_handle'),
  headerMediaUrl: text('header_media_url'),
  submissionError: text('submission_error'),
  lastSubmittedAt: timestamp('last_submitted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

// ============================================================
// PIPELINES & DEALS
// ============================================================
export const pipelines = pgTable('pipelines', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => accounts.id, {
    onDelete: 'cascade',
  }),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
})

export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
    color: text('color').notNull().default('#3b82f6'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [index('idx_pipeline_stages_pipeline').on(t.pipelineId)],
)

export const deals = pgTable(
  'deals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').references(() => accounts.id, {
      onDelete: 'cascade',
    }),
    pipelineId: uuid('pipeline_id')
      .notNull()
      .references(() => pipelines.id, { onDelete: 'cascade' }),
    stageId: uuid('stage_id')
      .notNull()
      .references(() => pipelineStages.id),
    contactId: uuid('contact_id').references(() => contacts.id),
    conversationId: uuid('conversation_id').references(() => conversations.id),
    assignedTo: uuid('assigned_to').references(() => profiles.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    value: numeric('value', { precision: 12, scale: 2 }).notNull().default('0'),
    currency: text('currency').default('USD'),
    notes: text('notes'),
    expectedCloseDate: date('expected_close_date'),
    status: text('status').default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index('idx_deals_pipeline').on(t.pipelineId),
    index('idx_deals_stage').on(t.stageId),
  ],
)

// ============================================================
// BROADCASTS
// ============================================================
export const broadcasts = pgTable('broadcasts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => accounts.id, {
    onDelete: 'cascade',
  }),
  name: text('name').notNull(),
  templateName: text('template_name').notNull(),
  templateLanguage: text('template_language').notNull().default('en_US'),
  templateVariables: jsonb('template_variables'),
  audienceFilter: jsonb('audience_filter'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  status: text('status').notNull().default('draft'),
  totalRecipients: integer('total_recipients').default(0),
  sentCount: integer('sent_count').default(0),
  deliveredCount: integer('delivered_count').default(0),
  readCount: integer('read_count').default(0),
  repliedCount: integer('replied_count').default(0),
  failedCount: integer('failed_count').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

export const broadcastRecipients = pgTable(
  'broadcast_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    broadcastId: uuid('broadcast_id')
      .notNull()
      .references(() => broadcasts.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    status: text('status').notNull().default('pending'),
    whatsappMessageId: text('whatsapp_message_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [index('idx_broadcast_recipients_broadcast').on(t.broadcastId)],
)

// ============================================================
// AUTOMATIONS
// ============================================================
export const automations = pgTable('automations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => accounts.id, {
    onDelete: 'cascade',
  }),
  name: text('name').notNull(),
  description: text('description'),
  triggerType: text('trigger_type').notNull(),
  triggerConfig: jsonb('trigger_config').notNull().default({}),
  isActive: boolean('is_active').notNull().default(false),
  executionCount: integer('execution_count').notNull().default(0),
  lastExecutedAt: timestamp('last_executed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const automationSteps = pgTable('automation_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  automationId: uuid('automation_id')
    .notNull()
    .references(() => automations.id, { onDelete: 'cascade' }),
  parentStepId: uuid('parent_step_id'),
  branch: text('branch'),
  stepType: text('step_type').notNull(),
  stepConfig: jsonb('step_config').notNull().default({}),
  position: integer('position').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const automationLogs = pgTable('automation_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  automationId: uuid('automation_id')
    .notNull()
    .references(() => automations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => accounts.id, {
    onDelete: 'cascade',
  }),
  contactId: uuid('contact_id').references(() => contacts.id, {
    onDelete: 'set null',
  }),
  triggerEvent: text('trigger_event').notNull(),
  stepsExecuted: jsonb('steps_executed').notNull().default([]),
  status: text('status').notNull(),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const automationPendingExecutions = pgTable('automation_pending_executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  automationId: uuid('automation_id')
    .notNull()
    .references(() => automations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => accounts.id, {
    onDelete: 'cascade',
  }),
  contactId: uuid('contact_id').references(() => contacts.id, {
    onDelete: 'set null',
  }),
  logId: uuid('log_id').references(() => automationLogs.id, {
    onDelete: 'cascade',
  }),
  parentStepId: uuid('parent_step_id').references(() => automationSteps.id, {
    onDelete: 'set null',
  }),
  branch: text('branch'),
  nextStepPosition: integer('next_step_position').notNull(),
  context: jsonb('context').notNull().default({}),
  status: text('status').notNull().default('pending'),
  runAt: timestamp('run_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ============================================================
// FLOWS
// ============================================================
export const flows = pgTable('flows', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => accounts.id, {
    onDelete: 'cascade',
  }),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull().default('draft'),
  triggerType: text('trigger_type').notNull(),
  triggerConfig: jsonb('trigger_config').notNull().default({}),
  entryNodeId: text('entry_node_id'),
  fallbackPolicy: jsonb('fallback_policy').notNull(),
  executionCount: integer('execution_count').notNull().default(0),
  lastExecutedAt: timestamp('last_executed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const flowNodes = pgTable(
  'flow_nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    nodeKey: text('node_key').notNull(),
    nodeType: text('node_type').notNull(),
    config: jsonb('config').notNull().default({}),
    positionX: integer('position_x').notNull().default(0),
    positionY: integer('position_y').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('flow_nodes_flow_id_node_key_key').on(t.flowId, t.nodeKey)],
)

export const flowRuns = pgTable('flow_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  flowId: uuid('flow_id')
    .notNull()
    .references(() => flows.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => accounts.id, {
    onDelete: 'cascade',
  }),
  contactId: uuid('contact_id').references(() => contacts.id, {
    onDelete: 'set null',
  }),
  conversationId: uuid('conversation_id').references(() => conversations.id, {
    onDelete: 'set null',
  }),
  status: text('status').notNull().default('active'),
  currentNodeKey: text('current_node_key'),
  lastPromptMessageId: uuid('last_prompt_message_id').references(() => messages.id, {
    onDelete: 'set null',
  }),
  vars: jsonb('vars').notNull().default({}),
  repromptCount: integer('reprompt_count').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  lastAdvancedAt: timestamp('last_advanced_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  endReason: text('end_reason'),
})

export const flowRunEvents = pgTable('flow_run_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  flowRunId: uuid('flow_run_id')
    .notNull()
    .references(() => flowRuns.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  nodeKey: text('node_key'),
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ============================================================
// PRESENCE & API KEYS
// ============================================================
export const memberPresence = pgTable('member_presence', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('online'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
})

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  name: text('name').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  scopes: text('scopes').array().notNull().default([]),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
