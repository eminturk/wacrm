import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { adminDb as db } from "@/lib/db/admin";
import {
  contactTags,
  contacts,
  conversations,
  flowNodes,
  flowRunEvents,
  flowRuns,
  flows,
  messages,
} from "@/lib/db/schema";
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from "./meta-send";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import {
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
} from "./types";

type AdminClient = typeof db;

const flowSelect = {
  id: flows.id,
  account_id: flows.accountId,
  user_id: flows.userId,
  name: flows.name,
  description: flows.description,
  status: flows.status,
  trigger_type: flows.triggerType,
  trigger_config: flows.triggerConfig,
  entry_node_id: flows.entryNodeId,
  fallback_policy: flows.fallbackPolicy,
  execution_count: flows.executionCount,
  last_executed_at: flows.lastExecutedAt,
  created_at: flows.createdAt,
  updated_at: flows.updatedAt,
};

const nodeSelect = {
  id: flowNodes.id,
  flow_id: flowNodes.flowId,
  node_key: flowNodes.nodeKey,
  node_type: flowNodes.nodeType,
  config: flowNodes.config,
  position_x: flowNodes.positionX,
  position_y: flowNodes.positionY,
  created_at: flowNodes.createdAt,
};

const runSelect = {
  id: flowRuns.id,
  flow_id: flowRuns.flowId,
  account_id: flowRuns.accountId,
  user_id: flowRuns.userId,
  contact_id: flowRuns.contactId,
  conversation_id: flowRuns.conversationId,
  status: flowRuns.status,
  current_node_key: flowRuns.currentNodeKey,
  last_prompt_message_id: flowRuns.lastPromptMessageId,
  vars: flowRuns.vars,
  reprompt_count: flowRuns.repromptCount,
  started_at: flowRuns.startedAt,
  last_advanced_at: flowRuns.lastAdvancedAt,
  ended_at: flowRuns.endedAt,
  end_reason: flowRuns.endReason,
};

const contactFieldColumns = {
  name: contacts.name,
  email: contacts.email,
  phone: contacts.phone,
  company: contacts.company,
} as const;

export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

export function matchesKeywordTrigger(text: string, cfg: KeywordTriggerConfig): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) return true;
  }
  return false;
}

export function isAutoAdvancing(node_type: string): boolean {
  return ["start", "send_message", "send_media", "condition", "set_tag"].includes(node_type);
}

export function isSuspending(node_type: string): boolean {
  return ["send_buttons", "send_list", "collect_input"].includes(node_type);
}

export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  subjectValue: string | undefined;
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}

async function loadActiveRunForContact(
  database: AdminClient,
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  try {
    const rows = await database
      .select(runSelect)
      .from(flowRuns)
      .where(
        and(
          eq(flowRuns.accountId, accountId),
          eq(flowRuns.contactId, contactId),
          eq(flowRuns.status, "active"),
        ),
      )
      .orderBy(desc(flowRuns.startedAt))
      .limit(1);
    return (rows[0] as unknown as FlowRunRow | undefined) ?? null;
  } catch (error) {
    console.error("[flows] loadActiveRunForContact error:", error instanceof Error ? error.message : error);
    return null;
  }
}

async function loadFlow(database: AdminClient, flowId: string): Promise<FlowRow | null> {
  try {
    const rows = await database.select(flowSelect).from(flows).where(eq(flows.id, flowId)).limit(1);
    return (rows[0] as unknown as FlowRow | undefined) ?? null;
  } catch (error) {
    console.error("[flows] loadFlow error:", error instanceof Error ? error.message : error);
    return null;
  }
}

async function loadAllNodes(database: AdminClient, flowId: string): Promise<Map<string, FlowNodeRow>> {
  try {
    const rows = await database.select(nodeSelect).from(flowNodes).where(eq(flowNodes.flowId, flowId));
    const map = new Map<string, FlowNodeRow>();
    for (const row of rows as unknown as FlowNodeRow[]) map.set(row.node_key, row);
    return map;
  } catch (error) {
    console.error("[flows] loadAllNodes error:", error instanceof Error ? error.message : error);
    return new Map();
  }
}

async function logEvent(
  database: AdminClient,
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    await database.insert(flowRunEvents).values({ flowRunId, eventType: event_type, nodeKey: node_key, payload });
  } catch (error) {
    console.error("[flows] logEvent error:", error instanceof Error ? error.message : error);
  }
}

async function isDuplicateInbound(
  database: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  const runs = await database
    .select({ id: flowRuns.id })
    .from(flowRuns)
    .where(and(eq(flowRuns.accountId, accountId), eq(flowRuns.contactId, contactId)));
  if (!runs.length) return false;
  const runIds = runs.map((r) => r.id);

  const [{ c }] = await database
    .select({ c: count() })
    .from(flowRunEvents)
    .where(
      and(
        inArray(flowRunEvents.flowRunId, runIds),
        eq(flowRunEvents.eventType, "reply_received"),
        sql`${flowRunEvents.payload}->>'meta_message_id' = ${metaMessageId}`,
      ),
    );
  return (c ?? 0) > 0;
}

async function findEntryFlow(
  database: AdminClient,
  accountId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
): Promise<FlowRow | null> {
  if (message.kind !== "text") return null;
  const rows = await database
    .select(flowSelect)
    .from(flows)
    .where(and(eq(flows.accountId, accountId), eq(flows.status, "active")))
    .orderBy(asc(flows.createdAt));
  for (const flow of rows as unknown as FlowRow[]) {
    if (flow.trigger_type === "keyword") {
      if (matchesKeywordTrigger(message.text, flow.trigger_config as KeywordTriggerConfig)) return flow;
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      return flow;
    }
  }
  return null;
}

async function setLastPromptMessage(database: AdminClient, runId: string, whatsappMessageId: string) {
  const [msg] = await database
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.messageId, whatsappMessageId))
    .limit(1);
  await database
    .update(flowRuns)
    .set({ lastPromptMessageId: msg?.id ?? null })
    .where(eq(flowRuns.id, runId));
}

async function sendButtonsAndSuspend(database: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    buttons: cfg.buttons.map((b) => ({ id: b.reply_id, title: b.title })),
  });
  await logEvent(database, run.id, "message_sent", node.node_key, { node_type: "send_buttons", whatsapp_message_id });
  await setLastPromptMessage(database, run.id, whatsapp_message_id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function sendListAndSuspend(database: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    buttonLabel: cfg.button_label,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    sections: cfg.sections.map((s) => ({
      title: s.title,
      rows: s.rows.map((r) => ({ id: r.reply_id, title: r.title, description: r.description })),
    })),
  });
  await logEvent(database, run.id, "message_sent", node.node_key, { node_type: "send_list", whatsapp_message_id });
  await setLastPromptMessage(database, run.id, whatsapp_message_id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function executeHandoff(database: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  const convUpdate: Partial<typeof conversations.$inferInsert> = { status: "pending", updatedAt: new Date() };
  if (cfg.assign_to) convUpdate.assignedAgentId = cfg.assign_to;
  if (run.conversation_id) {
    await database
      .update(conversations)
      .set(convUpdate)
      .where(and(eq(conversations.id, run.conversation_id), eq(conversations.accountId, run.account_id)));
  }
  await logEvent(database, run.id, "handoff", node.node_key, { note: cfg.note ?? null, assigned_to: cfg.assign_to ?? null });
  await endRun(database, run.id, "handed_off", "handoff_node");
}

async function evaluateConditionNode(database: AdminClient, run: FlowRunRow, cfg: ConditionNodeConfig): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === "var") {
    const v = run.vars[cfg.subject_key];
    subjectValue = typeof v === "string" ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === "tag") {
    const [{ c }] = await database
      .select({ c: count() })
      .from(contactTags)
      .where(and(eq(contactTags.contactId, run.contact_id!), eq(contactTags.tagId, cfg.subject_key)));
    subjectValue = (c ?? 0) > 0 ? cfg.subject_key : undefined;
  } else {
    const column = contactFieldColumns[cfg.subject_key as keyof typeof contactFieldColumns];
    if (!column) throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    const [data] = await database
      .select({ value: column })
      .from(contacts)
      .where(and(eq(contacts.id, run.contact_id!), eq(contacts.accountId, run.account_id)))
      .limit(1);
    const raw = data?.value;
    subjectValue = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
  return evaluateConditionPredicate({ operator: cfg.operator, subjectValue, configValue: cfg.value });
}

function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

async function endRun(
  database: AdminClient,
  runId: string,
  status: "completed" | "handed_off" | "timed_out" | "failed",
  reason: string,
): Promise<void> {
  await database.update(flowRuns).set({ status, endedAt: new Date(), endReason: reason }).where(eq(flowRuns.id, runId));
}

async function advanceFromNodeKey(
  database: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  let currentKey: string | null = startNodeKey;
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(database, run.id, "error", null, { reason: "next_node_key was null mid-advance" });
      await endRun(database, run.id, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(database, run.id, "error", currentKey, { reason: "node_not_found" });
      await endRun(database, run.id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    await logEvent(database, run.id, "node_entered", node.node_key, { node_type: node.node_type });

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars),
        });
        await logEvent(database, run.id, "message_sent", node.node_key, { node_type: "send_message", whatsapp_message_id });
      } catch (err) {
        await logEvent(database, run.id, "error", node.node_key, { reason: "send_text_failed", detail: err instanceof Error ? err.message : String(err) });
        await endRun(database, run.id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption ? interpolateVars(cfg.caption, run.vars) : undefined,
          filename: cfg.filename,
        });
        await logEvent(database, run.id, "message_sent", node.node_key, { node_type: "send_media", media_type: cfg.media_type, whatsapp_message_id });
      } catch (err) {
        await logEvent(database, run.id, "error", node.node_key, { reason: "send_media_failed", detail: err instanceof Error ? err.message : String(err) });
        await endRun(database, run.id, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "collect_input") {
      const cfg = node.config as unknown as CollectInputNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
        await logEvent(database, run.id, "message_sent", node.node_key, { node_type: "collect_input", whatsapp_message_id });
        await setLastPromptMessage(database, run.id, whatsapp_message_id);
      } catch (err) {
        await logEvent(database, run.id, "error", node.node_key, { reason: "collect_input_prompt_failed", detail: err instanceof Error ? err.message : String(err) });
        await endRun(database, run.id, "failed", "collect_input_prompt_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(database, run.id, run.current_node_key, node.node_key);
      if (!advanced) await logEvent(database, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
      return { outcome: "advanced" };
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(database, run, cfg)) ? "true" : "false";
      } catch (err) {
        await logEvent(database, run.id, "error", node.node_key, { reason: "condition_evaluation_failed", detail: err instanceof Error ? err.message : String(err) });
        await endRun(database, run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey = branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(database, run.id, "node_entered", node.node_key, { condition_result: branch, advancing_to: currentKey });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === "add") {
          await database
            .insert(contactTags)
            .values({ contactId: run.contact_id!, tagId: cfg.tag_id })
            .onConflictDoUpdate({ target: [contactTags.contactId, contactTags.tagId], set: { tagId: cfg.tag_id } });
        } else {
          await database.delete(contactTags).where(and(eq(contactTags.contactId, run.contact_id!), eq(contactTags.tagId, cfg.tag_id)));
        }
      } catch (err) {
        await logEvent(database, run.id, "error", node.node_key, { reason: "set_tag_failed", detail: err instanceof Error ? err.message : String(err) });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_buttons") {
      await sendButtonsAndSuspend(database, run, node);
      const advanced = await advanceCurrentNodeKey(database, run.id, run.current_node_key, node.node_key);
      if (!advanced) await logEvent(database, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      await sendListAndSuspend(database, run, node);
      const advanced = await advanceCurrentNodeKey(database, run.id, run.current_node_key, node.node_key);
      if (!advanced) await logEvent(database, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
      return { outcome: "advanced" };
    }
    if (node.node_type === "handoff") {
      await executeHandoff(database, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "end") {
      await logEvent(database, run.id, "completed", node.node_key);
      await endRun(database, run.id, "completed", "end_node");
      return { outcome: "completed" };
    }
    await logEvent(database, run.id, "error", node.node_key, { reason: `unknown_node_type:${node.node_type}` });
    await endRun(database, run.id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  await logEvent(database, run.id, "error", currentKey, { reason: "advance_loop_safety_break" });
  await endRun(database, run.id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

async function advanceCurrentNodeKey(database: AdminClient, runId: string, expectedOldKey: string | null, newKey: string): Promise<boolean> {
  const oldKeyCondition = expectedOldKey === null ? isNull(flowRuns.currentNodeKey) : eq(flowRuns.currentNodeKey, expectedOldKey);
  try {
    const data = await database
      .update(flowRuns)
      .set({ currentNodeKey: newKey, lastAdvancedAt: new Date() })
      .where(and(eq(flowRuns.id, runId), eq(flowRuns.status, "active"), oldKeyCondition))
      .returning({ id: flowRuns.id });
    return data.length > 0;
  } catch (error) {
    console.error("[flows] advanceCurrentNodeKey error:", error instanceof Error ? error.message : error);
    return false;
  }
}

export async function dispatchInboundToFlows(input: DispatchInboundInput & { isFirstInboundMessage: boolean }): Promise<DispatchInboundResult> {
  try {
    const activeRun = await loadActiveRunForContact(db, input.accountId, input.contactId);
    if (activeRun) {
      const dupe = await isDuplicateInbound(db, input.accountId, input.contactId, input.message.meta_message_id);
      if (dupe) return { consumed: true, flow_run_id: activeRun.id, outcome: "duplicate_inbound_ignored" };
      const nodes = await loadAllNodes(db, activeRun.flow_id);
      return handleReplyForActiveRun(db, activeRun, input.message, nodes);
    }

    const flow = await findEntryFlow(db, input.accountId, input.message, input.isFirstInboundMessage);
    if (!flow || !flow.entry_node_id) return { consumed: false, outcome: "no_match" };
    const nodes = await loadAllNodes(db, flow.id);
    return startNewRun(db, flow, input, nodes);
  } catch (err) {
    console.error("[flows] dispatchInboundToFlows threw:", err instanceof Error ? err.message : err);
    return { consumed: false, outcome: "no_match" };
  }
}

async function handleReplyForActiveRun(database: AdminClient, run: FlowRunRow, message: ParsedInbound, nodes: Map<string, FlowNodeRow>): Promise<DispatchInboundResult> {
  await logEvent(database, run.id, "reply_received", run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
  });

  if (!run.current_node_key) {
    await endRun(database, run.id, "failed", "active_run_missing_current_node");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(database, run.id, "failed", "current_node_not_found");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  let matched: string | null = null;
  if (message.kind === "interactive_reply" && (currentNode.node_type === "send_buttons" || currentNode.node_type === "send_list")) {
    matched = matchReplyId(currentNode, message.reply_id);
  } else if (message.kind === "text" && currentNode.node_type === "collect_input") {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    if (captured.length > 0 && cfg.var_key) {
      const newVars = { ...run.vars, [cfg.var_key]: captured };
      try {
        await database.update(flowRuns).set({ vars: newVars, repromptCount: 0 }).where(eq(flowRuns.id, run.id));
        run.vars = newVars;
        run.reprompt_count = 0;
        await logEvent(database, run.id, "node_entered", currentNode.node_key, { captured_key: cfg.var_key, captured_length: captured.length });
        matched = cfg.next_node_key;
      } catch {
        // Keep old behavior: failed capture means no match and fallback handles it.
      }
    }
  }

  if (matched) {
    if (run.reprompt_count !== 0) {
      try {
        await database.update(flowRuns).set({ repromptCount: 0 }).where(eq(flowRuns.id, run.id));
        run.reprompt_count = 0;
      } catch {
        // Non-fatal.
      }
    }
    const outcome = await advanceFromNodeKey(database, run, matched, nodes);
    return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
  }

  const policy = resolveFallbackPolicy((await loadFlow(database, run.flow_id))?.fallback_policy);
  const newReprompts = run.reprompt_count + 1;
  await database.update(flowRuns).set({ repromptCount: newReprompts }).where(eq(flowRuns.id, run.id));
  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(database, run.id, "fallback_fired", run.current_node_key, { action: action.type, reprompt_count: newReprompts });

  if (action.type === "ignore") return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  if (action.type === "reprompt") {
    if (currentNode.node_type === "send_buttons") {
      await sendButtonsAndSuspend(database, run, currentNode);
    } else if (currentNode.node_type === "send_list") {
      await sendListAndSuspend(database, run, currentNode);
    } else if (currentNode.node_type === "collect_input") {
      const cfg = currentNode.config as unknown as CollectInputNodeConfig;
      try {
        await engineSendText({
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
      } catch (err) {
        await logEvent(database, run.id, "error", currentNode.node_key, { reason: "reprompt_send_failed", detail: err instanceof Error ? err.message : String(err) });
      }
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    if (run.conversation_id) {
      await database
        .update(conversations)
        .set({ status: "pending", updatedAt: new Date() })
        .where(and(eq(conversations.id, run.conversation_id), eq(conversations.accountId, run.account_id)));
    }
    await logEvent(database, run.id, "handoff", run.current_node_key, { reason: "fallback_exhausted" });
    await endRun(database, run.id, "handed_off", "fallback_exhausted");
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }
  await endRun(database, run.id, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

async function startNewRun(database: AdminClient, flow: FlowRow, input: DispatchInboundInput, nodes: Map<string, FlowNodeRow>): Promise<DispatchInboundResult> {
  let run: FlowRunRow;
  try {
    const [inserted] = await database
      .insert(flowRuns)
      .values({
        flowId: flow.id,
        accountId: flow.account_id,
        userId: flow.user_id,
        contactId: input.contactId,
        conversationId: input.conversationId,
        status: "active",
        currentNodeKey: flow.entry_node_id,
      })
      .returning(runSelect);
    run = inserted as unknown as FlowRunRow;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("23505") || msg.includes("duplicate key")) return { consumed: true, outcome: "duplicate_inbound_ignored" };
    console.error("[flows] startNewRun insert error:", msg);
    return { consumed: false, outcome: "no_match" };
  }

  await logEvent(database, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });
  try {
    await database.execute(sql`SELECT increment_flow_execution_count(${flow.id}::uuid)`);
  } catch (err) {
    console.error("[flows] execution_count increment error:", err instanceof Error ? err.message : err);
  }

  const outcome = await advanceFromNodeKey(database, run, flow.entry_node_id!, nodes);
  return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome };
}
