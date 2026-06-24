"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Count of conversations with at least one unread inbound message for
 * the current account. Used by the sidebar to surface a green dot on
 * the Inbox nav entry when the user is elsewhere in the app.
 *
 * Snapshots `/api/conversations` and refreshes on SSE `conversation`
 * events from `/api/realtime` (pg_notify on the conversations table).
 */
export function useTotalUnread(): number {
  const [total, setTotal] = useState(0);

  // Live local mirror of {id: unread_count} so events can adjust the
  // total without a full refetch when possible.
  const countsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch("/api/conversations", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          conversations: { id: string; unread_count: number | null }[];
        };
        const map = new Map<string, number>();
        let sum = 0;
        for (const row of data.conversations ?? []) {
          const n = row.unread_count ?? 0;
          map.set(row.id, n);
          if (n > 0) sum += 1;
        }
        countsRef.current = map;
        setTotal(sum);
      } catch {
        // best-effort
      }
    };

    void load();

    let es: EventSource | null = null;
    if (typeof window !== "undefined") {
      es = new EventSource("/api/realtime");
      // A conversation changed — refetch to recompute the badge.
      es.addEventListener("conversation", () => void load());
      es.addEventListener("message", () => void load());
    }

    return () => {
      cancelled = true;
      if (es) es.close();
    };
  }, []);

  return total;
}
