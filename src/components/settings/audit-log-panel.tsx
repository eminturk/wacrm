'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ClipboardList, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { SettingsPanelHead } from './settings-panel-head';

type AuditLog = {
  id: string;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  user_id: string | null;
  metadata: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
};

const ACTION_COLOR: Record<string, string> = {
  'login.success': 'text-green-600 dark:text-green-400',
  'login.failure': 'text-destructive',
  'contact.opted_out': 'text-amber-600 dark:text-amber-400',
  'ip_allowlist.update': 'text-blue-600 dark:text-blue-400',
};

export function AuditLogPanel() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (actionFilter) params.set('action', actionFilter);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await fetch(`/api/audit-logs?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load');
      setLogs(data.audit_logs ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load audit logs');
    } finally {
      setLoading(false);
    }
  }, [actionFilter, from, to]);

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  return (
    <section className="max-w-4xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Audit Log"
        description="Immutable record of security-relevant events: logins, settings changes, opt-outs, IP updates."
      />

      <div className="mb-4 flex flex-wrap gap-3">
        <Input
          placeholder="Filter by action (e.g. login)"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="w-52"
        />
        <Input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-38"
        />
        <Input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-38"
        />
        <Button variant="outline" size="sm" onClick={() => void fetchLogs()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-muted-foreground text-sm">Loading…</span>
        </div>
      ) : logs.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 py-12">
          <ClipboardList className="h-8 w-8 opacity-40" />
          <p className="text-sm">No audit log entries found.</p>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Resource</TableHead>
                <TableHead>IP Address</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="text-muted-foreground whitespace-nowrap text-xs tabular-nums">
                    {new Date(log.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`font-mono text-xs ${ACTION_COLOR[log.action] ?? 'text-foreground'}`}
                    >
                      {log.action}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {log.resource_type ?? '—'}
                    {log.resource_id && (
                      <span className="ml-1 font-mono opacity-70">
                        ({log.resource_id.slice(0, 8)}…)
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {log.ip_address ?? '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground max-w-xs truncate text-xs">
                    {Object.keys(log.metadata).length > 0
                      ? JSON.stringify(log.metadata)
                      : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
