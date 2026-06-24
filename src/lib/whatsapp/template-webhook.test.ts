import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (column: { name?: string }, value: unknown) => ({
      column: column.name,
      value,
    }),
  };
});

import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from './template-webhook';

function makeDbStub(returningRows: { id: string }[] = [{ id: 'row-1' }]) {
  const calls: {
    update?: Record<string, unknown>;
    filter?: unknown;
    returning?: boolean;
  }[] = [];

  const stub = {
    update() {
      const entry: (typeof calls)[number] = {};
      calls.push(entry);
      return {
        set(payload: Record<string, unknown>) {
          entry.update = payload;
          return {
            where(filter: unknown) {
              entry.filter = filter;
              return {
                returning() {
                  entry.returning = true;
                  return Promise.resolve(returningRows);
                },
              };
            },
          };
        },
      };
    },
  };

  return { stub: stub as unknown as typeof import('@/lib/db').db, calls };
}

describe('isTemplateWebhookField', () => {
  it('recognises the three template fields', () => {
    expect(isTemplateWebhookField('message_template_status_update')).toBe(true);
    expect(isTemplateWebhookField('message_template_quality_update')).toBe(
      true
    );
    expect(isTemplateWebhookField('message_template_components_update')).toBe(
      true
    );
  });
  it('rejects messaging fields', () => {
    expect(isTemplateWebhookField('messages')).toBe(false);
    expect(isTemplateWebhookField('message_status')).toBe(false);
  });
});

describe('handleTemplateWebhookChange — status update', () => {
  let dbCalls: ReturnType<typeof makeDbStub>['calls'];

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('flips status to APPROVED and clears any rejection_reason', async () => {
    const { stub, calls } = makeDbStub();
    dbCalls = calls;
    await handleTemplateWebhookChange(
      {
        field: 'message_template_status_update',
        value: {
          event: 'APPROVED',
          message_template_id: 12345,
          message_template_name: 'order_confirmation',
          message_template_language: 'en_US',
        },
      },
      stub
    );
    expect(dbCalls).toHaveLength(1);
    expect(dbCalls[0].filter).toEqual({
      column: 'meta_template_id',
      value: '12345',
    });
    expect(dbCalls[0].update).toEqual({
      status: 'APPROVED',
      rejectionReason: null,
      submissionError: null,
    });
  });

  it('persists the reason field on REJECTED', async () => {
    const { stub, calls } = makeDbStub();
    await handleTemplateWebhookChange(
      {
        field: 'message_template_status_update',
        value: {
          event: 'REJECTED',
          message_template_id: 'TMPL_99',
          reason: 'Template uses non-compliant language.',
        },
      },
      stub
    );
    expect(calls[0].update?.status).toBe('REJECTED');
    expect(calls[0].update?.rejectionReason).toBe(
      'Template uses non-compliant language.'
    );
  });

  it('falls back to a generic reason when REJECTED has no `reason`', async () => {
    const { stub, calls } = makeDbStub();
    await handleTemplateWebhookChange(
      {
        field: 'message_template_status_update',
        value: { event: 'REJECTED', message_template_id: '7' },
      },
      stub
    );
    expect(calls[0].update?.rejectionReason).toBe('Rejected by Meta');
  });

  it('normalises PENDING_REVIEW → PENDING (via shared normalizeStatus)', async () => {
    const { stub, calls } = makeDbStub();
    await handleTemplateWebhookChange(
      {
        field: 'message_template_status_update',
        value: { event: 'PENDING_REVIEW', message_template_id: '1' },
      },
      stub
    );
    expect(calls[0].update?.status).toBe('PENDING');
  });

  it('logs and exits when meta_template_id is missing (no UPDATE issued)', async () => {
    const { stub, calls } = makeDbStub();
    await handleTemplateWebhookChange(
      {
        field: 'message_template_status_update',
        value: { event: 'APPROVED' },
      },
      stub
    );
    expect(calls).toHaveLength(0);
  });

  it('logs a warning when the row is unknown locally (zero matches)', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { stub } = makeDbStub([]);
    await handleTemplateWebhookChange(
      {
        field: 'message_template_status_update',
        value: {
          event: 'APPROVED',
          message_template_id: 'NEVER_SEEN',
          message_template_name: 'mystery',
        },
      },
      stub
    );
    expect(warn).toHaveBeenCalled();
  });
});

describe('handleTemplateWebhookChange — quality update', () => {
  it('sets quality_score from new_quality_score', async () => {
    const { stub, calls } = makeDbStub();
    await handleTemplateWebhookChange(
      {
        field: 'message_template_quality_update',
        value: {
          message_template_id: '99',
          previous_quality_score: 'GREEN',
          new_quality_score: 'YELLOW',
        },
      },
      stub
    );
    expect(calls[0].update).toEqual({ qualityScore: 'YELLOW' });
    expect(calls[0].filter).toEqual({
      column: 'meta_template_id',
      value: '99',
    });
  });

  it('stores null for unrecognised quality scores', async () => {
    const { stub, calls } = makeDbStub();
    await handleTemplateWebhookChange(
      {
        field: 'message_template_quality_update',
        value: {
          message_template_id: '99',
          new_quality_score: 'PURPLE',
        },
      },
      stub
    );
    expect(calls[0].update).toEqual({ qualityScore: null });
  });
});

describe('handleTemplateWebhookChange — components update', () => {
  it('is an info-log no-op (does not write to DB)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { stub, calls } = makeDbStub();
    await handleTemplateWebhookChange(
      {
        field: 'message_template_components_update',
        value: {
          message_template_id: '5',
          message_template_name: 'x',
        },
      },
      stub
    );
    expect(calls).toHaveLength(0);
    expect(info).toHaveBeenCalled();
  });
});

describe('handleTemplateWebhookChange — unknown field', () => {
  it('is a defensive no-op', async () => {
    const { stub, calls } = makeDbStub();
    await handleTemplateWebhookChange(
      { field: 'message_template_future_field', value: {} },
      stub
    );
    expect(calls).toHaveLength(0);
  });
});
