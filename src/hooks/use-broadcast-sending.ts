'use client';

import { useState } from 'react';
import { Contact, MessageTemplate, BroadcastRecipient } from '@/types';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

/**
 * Variable mapping — each template placeholder (by key, usually "1",
 * "2", …) is resolved at send time. `field` maps to a built-in contact
 * field (name/phone/email/company); `custom_field` maps to a
 * contact_custom_values.value row keyed by the custom_fields.id stored
 * in `value`.
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

/**
 * Meta rate-limit buffer. 10 per batch + 1 s pause matches the spec
 * and keeps us comfortably under Meta's per-phone-number messaging
 * rate so a large broadcast never trips the upstream limiter.
 */
const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BroadcastApiResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

/** contactId → (customFieldId → value). */
type CustomValueIndex = Map<string, Map<string, string>>;

type RecipientWithContact = BroadcastRecipient & { contact?: Contact | null };

type RecipientUpdate = {
  id: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string | null;
  sent_at?: string | null;
  error_message?: string | null;
};

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data as T;
}

/**
 * Per-contact resolution of custom-field placeholders. Static and
 * built-in-field mappings resolve synchronously; custom fields read
 * from a pre-built index to avoid N+1 queries during the send loop.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>
): string[] {
  // Keys are typically "1","2",... — numeric-aware sort keeps
  // {{1}} before {{10}}.
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const v = variables[key];
    if (v.type === 'static') return v.value;

    if (v.type === 'field') {
      const fieldMap: Record<string, string | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      return fieldMap[v.value] ?? '';
    }

    // custom_field
    return customValues?.get(v.value) ?? '';
  });
}

async function resolveAudience(audience: AudienceConfig): Promise<Contact[]> {
  const data = await apiJson<{ contacts: Contact[]; count: number }>(
    '/api/broadcasts/audience',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resolve', audience }),
    }
  );
  return data.contacts ?? [];
}

/**
 * Bulk-fetch contact_custom_values for a set of contacts. Returns an
 * index keyed by contact_id → field_id → value.
 */
async function fetchCustomValueIndex(
  contactIds: string[]
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  if (contactIds.length === 0) return index;

  const PAGE = 500;
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const slice = contactIds.slice(i, i + PAGE);
    const data = await apiJson<{
      values: { contact_id: string; custom_field_id: string; value?: string }[];
    }>('/api/broadcasts/audience', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'custom-values', contactIds: slice }),
    });

    for (const row of data.values ?? []) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? '');
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function patchRecipientUpdates(
    broadcastId: string,
    updates: RecipientUpdate[]
  ) {
    if (updates.length === 0) return;
    await apiJson(`/api/broadcasts/${broadcastId}/recipients`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    });
  }

  async function pollBroadcastProgress(broadcastId: string) {
    const data = await apiJson<{
      summary: { total: number; counts: Record<string, number> };
    }>(`/api/broadcasts/${broadcastId}/recipients`, { cache: 'no-store' });
    const total = data.summary.total || 1;
    const completed =
      (data.summary.counts.sent ?? 0) +
      (data.summary.counts.delivered ?? 0) +
      (data.summary.counts.read ?? 0) +
      (data.summary.counts.replied ?? 0) +
      (data.summary.counts.failed ?? 0);
    setProgress((current) =>
      Math.max(current, 30 + Math.round((completed / total) * 60))
    );
  }

  async function createAndSendBroadcast(
    payload: BroadcastPayload
  ): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    try {
      // ── Step 1: Resolve audience contacts ─────────────────────────
      setProgress(5);
      const contacts = await resolveAudience(payload.audience);

      if (contacts.length === 0) {
        throw new Error('No contacts found for this audience.');
      }

      // ── Step 2: Create broadcast + recipient rows ─────────────────
      setProgress(10);
      const created = await apiJson<{
        broadcast: { id: string };
        recipients: RecipientWithContact[];
      }>('/api/broadcasts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          template_variables: payload.variables,
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
            customField: payload.audience.customField,
            excludeTagIds: payload.audience.excludeTagIds,
          },
          status: 'sending',
          contactIds: contacts.map((contact) => contact.id),
        }),
      });

      const broadcastId = created.broadcast.id;
      const recipients = created.recipients ?? [];
      if (recipients.length === 0) {
        throw new Error('Failed to create broadcast recipients.');
      }

      // One bulk fetch of custom values for every contact in this
      // broadcast, avoiding N+1 during the send loop.
      setProgress(30);
      const contactIds = recipients
        .map((r) => r.contact?.id)
        .filter((id): id is string => Boolean(id));
      const customValueIndex = await fetchCustomValueIndex(contactIds);

      let failedCount = 0;
      const totalRecipients = recipients.length;

      for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
        const batch = recipients.slice(i, i + SEND_BATCH_SIZE);

        const apiRecipients = batch
          .filter((r) => r.contact?.phone)
          .map((r) => ({
            phone: r.contact!.phone as string,
            params: r.contact
              ? resolveVariables(
                  payload.variables,
                  r.contact,
                  customValueIndex.get(r.contact.id)
                )
              : [],
          }));

        if (apiRecipients.length === 0) {
          failedCount += batch.length;
          await patchRecipientUpdates(
            broadcastId,
            batch.map((recipient) => ({
              id: recipient.id,
              status: 'failed',
              error_message: 'No phone number on contact',
            }))
          );
          await pollBroadcastProgress(broadcastId);
          continue;
        }

        try {
          const data = await apiJson<{ results?: BroadcastApiResult[] }>(
            '/api/whatsapp/broadcast',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                recipients: apiRecipients,
                template_name: payload.template.name,
                template_language: payload.template.language ?? 'en_US',
              }),
            }
          );

          const resultsByPhone = new Map<string, BroadcastApiResult>();
          for (const r of data.results ?? []) resultsByPhone.set(r.phone, r);

          const updates: RecipientUpdate[] = [];
          for (const recipient of batch) {
            const phone = recipient.contact?.phone;
            const result = phone ? resultsByPhone.get(phone) : undefined;

            if (!result) {
              failedCount++;
              updates.push({
                id: recipient.id,
                status: 'failed',
                error_message: 'No phone number on contact',
              });
              continue;
            }

            if (result.status === 'sent') {
              updates.push({
                id: recipient.id,
                status: 'sent',
                sent_at: new Date().toISOString(),
                whatsapp_message_id: result.whatsapp_message_id ?? null,
                error_message: null,
              });
            } else {
              failedCount++;
              updates.push({
                id: recipient.id,
                status: 'failed',
                error_message: result.error ?? 'Unknown error',
              });
            }
          }
          await patchRecipientUpdates(broadcastId, updates);
        } catch (err) {
          failedCount += batch.length;
          await patchRecipientUpdates(
            broadcastId,
            batch.map((recipient) => ({
              id: recipient.id,
              status: 'failed',
              error_message:
                err instanceof Error ? err.message : 'Unknown error',
            }))
          );
        }

        await pollBroadcastProgress(broadcastId);

        if (i + SEND_BATCH_SIZE < recipients.length) {
          await sleep(SEND_BATCH_DELAY_MS);
        }
      }

      // ── Step 5: Finalize status ───────────────────────────────────
      setProgress(95);
      const finalStatus = failedCount === totalRecipients ? 'failed' : 'sent';
      await apiJson(`/api/broadcasts/${broadcastId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: finalStatus }),
      });

      setProgress(100);
      return broadcastId;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}
