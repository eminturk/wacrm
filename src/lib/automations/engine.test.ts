import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared mock state for the Drizzle admin database handle. Lives in a
// hoisted block so the vi.mock factory below can close over it.
const h = vi.hoisted(() => {
  const tableNameSymbol = Symbol.for('drizzle:Name');

  function tableName(table: unknown) {
    return (
      (table as Record<symbol, string | undefined>)?.[tableNameSymbol] ??
      'unknown'
    );
  }

  function extractEqFilters(whereExpr: unknown) {
    const filters: ['eq', string, unknown][] = [];

    function visit(node: unknown) {
      if (!node || typeof node !== 'object') return;
      const record = node as {
        queryChunks?: unknown[];
        name?: string;
        value?: unknown;
      };
      const chunks = record.queryChunks;
      if (Array.isArray(chunks)) {
        for (let i = 0; i < chunks.length; i += 1) {
          const column = chunks[i] as { name?: string } | undefined;
          const maybeEquals = chunks[i + 1] as { value?: unknown } | undefined;
          const param = chunks[i + 2] as
            | { value?: unknown; constructor?: { name?: string } }
            | undefined;
          if (
            typeof column?.name === 'string' &&
            Array.isArray(maybeEquals?.value) &&
            maybeEquals.value.includes(' = ') &&
            param?.constructor?.name === 'Param'
          ) {
            filters.push(['eq', column.name, param.value]);
          }
          visit(chunks[i]);
        }
      }
    }

    visit(whereExpr);
    return filters;
  }

  const state = {
    owned: null as { id: string } | null,
    ownedCustomField: null as { id: string } | null,
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    fromCalls: [] as string[],
    updateCalls: [] as {
      table: string;
      payload: unknown;
      filters: ['eq', string, unknown][];
    }[],
    upsertCalls: [] as { table: string; payload: unknown }[],
    executeCalls: [] as unknown[],
  };

  function rowsFor(table: string) {
    if (table === 'contacts') return state.owned ? [state.owned] : [];
    if (table === 'custom_fields')
      return state.ownedCustomField ? [state.ownedCustomField] : [];
    if (table === 'automations') return state.automations;
    if (table === 'automation_steps') return state.steps;
    if (table === 'automation_logs')
      return [{ steps_executed: [], status: 'success' }];
    return [];
  }

  function queryBuilder(
    kind: 'select' | 'insert' | 'update' | 'delete',
    table?: unknown
  ) {
    const ops = {
      kind,
      table: table ? tableName(table) : 'unknown',
      payload: undefined as unknown,
      filters: [] as ['eq', string, unknown][],
    };

    const resolve = () => {
      if (ops.kind === 'select') return rowsFor(ops.table);
      if (ops.kind === 'insert' && ops.table === 'automation_logs')
        return [{ id: 'log1' }];
      return [];
    };

    const b = {
      from(nextTable: unknown) {
        ops.table = tableName(nextTable);
        state.fromCalls.push(ops.table);
        return b;
      },
      values(payload: unknown) {
        ops.payload = payload;
        return b;
      },
      set(payload: unknown) {
        ops.payload = payload;
        return b;
      },
      where(whereExpr: unknown) {
        ops.filters = extractEqFilters(whereExpr);
        if (ops.kind === 'update') {
          state.updateCalls.push({
            table: ops.table,
            payload: ops.payload,
            filters: ops.filters,
          });
        }
        return b;
      },
      limit: () => b,
      orderBy: () => b,
      returning: () => Promise.resolve(resolve()),
      onConflictDoNothing: () => Promise.resolve([]),
      onConflictDoUpdate: () => {
        state.upsertCalls.push({ table: ops.table, payload: ops.payload });
        return Promise.resolve([]);
      },
      then: (
        onFulfilled: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown
      ) => Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };

    return b;
  }

  const fakeDb = {
    select: () => queryBuilder('select'),
    insert: (table: unknown) => queryBuilder('insert', table),
    update: (table: unknown) => queryBuilder('update', table),
    delete: (table: unknown) => queryBuilder('delete', table),
    execute: (query: unknown) => {
      state.executeCalls.push(query);
      return Promise.resolve([]);
    },
  };

  return { state, fakeDb };
});

vi.mock('@/lib/db/admin', () => ({
  adminDb: h.fakeDb,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
}));

vi.mock('./meta-send', () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
}));

import { runAutomationsForTrigger } from './engine';

const ACCOUNT = 'acct-1';

beforeEach(() => {
  h.state.owned = null;
  h.state.ownedCustomField = null;
  h.state.automations = [];
  h.state.steps = [];
  h.state.fromCalls = [];
  h.state.updateCalls = [];
  h.state.upsertCalls = [];
  h.state.executeCalls = [];
});

describe('runAutomationsForTrigger — tenant isolation', () => {
  it('refuses to dispatch when the contact is not in the account (GHSA-63cv-2c49-m5v3)', async () => {
    // Ownership lookup returns nothing — the contact belongs to another tenant.
    h.state.owned = null;
    // If the guard failed, this automation would run an update_contact_field step.
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'victim-contact-uuid',
      context: { message_text: 'manual trigger' },
    });

    // Bailed at the guard: never fetched automations, never wrote a contact.
    expect(h.state.fromCalls).toContain('contacts');
    expect(h.state.fromCalls).not.toContain('automations');
    expect(
      h.state.updateCalls.filter((call) => call.table === 'contacts')
    ).toHaveLength(0);
  });

  it('proceeds past the guard when the contact belongs to the account', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = []; // no matching automations; just prove we got past the guard

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.fromCalls).toContain('automations');
  });

  it("scopes the update_contact_field write to the automation's account", async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    const contactUpdates = h.state.updateCalls.filter(
      (call) => call.table === 'contacts'
    );
    expect(contactUpdates).toHaveLength(1);
    expect(contactUpdates[0].filters).toContainEqual(['eq', 'id', 'c1']);
    expect(contactUpdates[0].filters).toContainEqual([
      'eq',
      'account_id',
      ACCOUNT,
    ]);
  });
});

describe('update_contact_field — custom fields', () => {
  it('upserts contact_custom_values when the field is account-owned', async () => {
    h.state.owned = { id: 'c1' };
    h.state.ownedCustomField = { id: 'cf1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('custom:cf1', 'Premium')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // No direct contacts column write for a custom field.
    expect(
      h.state.updateCalls.filter((call) => call.table === 'contacts')
    ).toHaveLength(0);
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0]).toMatchObject({
      table: 'contact_custom_values',
      payload: {
        contactId: 'c1',
        customFieldId: 'cf1',
        value: 'Premium',
      },
    });
  });

  it('interpolates {{ vars.* }} into the custom value', async () => {
    h.state.owned = { id: 'c1' };
    h.state.ownedCustomField = { id: 'cf1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('custom:cf1', '{{ vars.source }}')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { vars: { source: 'WhatsApp Ad' } },
    });

    expect(h.state.upsertCalls).toHaveLength(1);
    expect((h.state.upsertCalls[0].payload as { value: string }).value).toBe(
      'WhatsApp Ad'
    );
  });

  it('refuses to write a custom field from another account', async () => {
    h.state.owned = { id: 'c1' };
    h.state.ownedCustomField = null; // account-scoped lookup finds nothing
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('custom:foreign-cf', 'x')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.upsertCalls).toHaveLength(0);
    expect(
      h.state.updateCalls.filter((call) => call.table === 'contacts')
    ).toHaveLength(0);
  });
});

function automationWithUpdateStep() {
  return {
    id: 'a1',
    account_id: ACCOUNT,
    user_id: 'u1',
    trigger_type: 'new_message_received',
    trigger_config: {},
    is_active: true,
  };
}

function updateStep() {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'update_contact_field',
    position: 0,
    parent_step_id: null,
    step_config: { field: 'company', value: 'pwned-by-automation' },
  };
}

function customStep(field: string, value: string) {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'update_contact_field',
    position: 0,
    parent_step_id: null,
    step_config: { field, value },
  };
}
