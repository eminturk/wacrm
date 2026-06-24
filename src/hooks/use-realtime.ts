"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import type { Message, Conversation } from "@/types";

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
}

interface UseRealtimeOptions {
  channelName: string;
  onMessageEvent?: (event: RealtimeEvent<Message>) => void;
  onConversationEvent?: (event: RealtimeEvent<Conversation>) => void;
  enabled?: boolean;
}

interface NotifyPayload {
  table: string;
  op: "INSERT" | "UPDATE" | "DELETE";
  id: string | null;
  account_id: string | null;
  conversation_id: string | null;
}

/**
 * Realtime subscription over Server-Sent Events (replaces the Supabase
 * Realtime channel). Connects to `/api/realtime`, which streams
 * pg_notify events from the database (migration 027 triggers).
 *
 * The SSE payload only carries identifiers — consumers should treat an
 * event as "something changed, refetch" rather than relying on a full
 * row. `new`/`old` are populated with the ids that are available.
 */
export function useRealtime({
  channelName: _channelName,
  onMessageEvent,
  onConversationEvent,
  enabled = true,
}: UseRealtimeOptions) {
  const esRef = useRef<EventSource | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onConversationRef.current = onConversationEvent;
  });

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;

    const es = new EventSource("/api/realtime");
    esRef.current = es;

    es.addEventListener("ready", () => setIsConnected(true));
    es.onopen = () => setIsConnected(true);
    es.onerror = () => setIsConnected(false);

    es.addEventListener("message", (e) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data) as NotifyPayload;
        onMessageRef.current?.({
          eventType: payload.op,
          new: {
            id: payload.id,
            conversation_id: payload.conversation_id,
          } as unknown as Message,
          old: { id: payload.id ?? undefined } as Partial<Message>,
        });
      } catch {
        // ignore malformed event
      }
    });

    es.addEventListener("conversation", (e) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data) as NotifyPayload;
        onConversationRef.current?.({
          eventType: payload.op,
          new: { id: payload.id } as unknown as Conversation,
          old: { id: payload.id ?? undefined } as Partial<Conversation>,
        });
      } catch {
        // ignore malformed event
      }
    });

    return () => {
      es.close();
      esRef.current = null;
      setIsConnected(false);
    };
  }, [enabled]);

  const unsubscribe = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
      setIsConnected(false);
    }
  }, []);

  return { isConnected, unsubscribe };
}
