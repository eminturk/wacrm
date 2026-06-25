"use client";

import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import {
  derivePresence,
  type PresenceRow,
  type PresenceStatus,
  type StoredPresence,
} from "@/lib/presence";

// How often the viewer re-derives presence locally (online→offline
// fires no event — it's just the clock passing the staleness threshold).
const RE_DERIVE_MS = 15_000;

type PresenceMap = Map<string, PresenceRow>;

interface UsePresenceResult {
  getPresence: (userId: string) => PresenceStatus;
  getRow: (userId: string) => PresenceRow | undefined;
  now: number;
}

interface PresenceApiRow {
  user_id: string;
  status: StoredPresence;
  last_seen_at: string;
}

/**
 * Live presence for every member of the caller's account. Snapshots
 * `/api/presence` and refreshes on SSE `presence` events from
 * `/api/realtime` (pg_notify on member_presence). "Offline" is derived
 * locally on a timer.
 */
export function usePresence(enabled = true): UsePresenceResult {
  const { accountId } = useAuth();
  const [rows, setRows] = useState<PresenceMap>(() => new Map());
  const [now, setNow] = useState(() => Date.now());

  const active = enabled && !!accountId;

  useEffect(() => {
    if (!active || !accountId) return;

    let cancelled = false;

    const snapshot = async () => {
      try {
        const res = await fetch("/api/presence", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { rows: PresenceApiRow[] };
        setRows((prev) => {
          const next = new Map(prev);
          for (const r of data.rows ?? []) {
            const incoming: PresenceRow = {
              status: r.status,
              last_seen_at: r.last_seen_at,
            };
            const existing = next.get(r.user_id);
            if (
              !existing ||
              new Date(incoming.last_seen_at) >= new Date(existing.last_seen_at)
            ) {
              next.set(r.user_id, incoming);
            }
          }
          return next;
        });
      } catch {
        // best-effort
      }
    };

    void snapshot();

    // Refresh on presence change events from the SSE stream. We refetch
    // the whole (small) roster rather than parse the minimal payload.
    let es: EventSource | null = null;
    if (typeof window !== "undefined") {
      es = new EventSource("/api/realtime");
      es.addEventListener("presence", () => {
        void snapshot();
      });
    }

    const tick = setInterval(() => setNow(Date.now()), RE_DERIVE_MS);

    return () => {
      cancelled = true;
      clearInterval(tick);
      if (es) es.close();
    };
  }, [active, accountId]);

  const getRow = useCallback(
    (userId: string): PresenceRow | undefined => rows.get(userId),
    [rows],
  );

  const getPresence = useCallback(
    (userId: string): PresenceStatus => {
      const row = rows.get(userId);
      return derivePresence(row?.status, row?.last_seen_at, now);
    },
    [rows, now],
  );

  return { getPresence, getRow, now };
}
