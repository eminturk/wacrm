'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  BarChart2,
  Download,
  Loader2,
  Search,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
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

type BroadcastReport = {
  id: string;
  name: string;
  template_name: string;
  template_language: string;
  status: string;
  total_recipients: number;
  sent_count: number;
  delivered_count: number;
  read_count: number;
  replied_count: number;
  failed_count: number;
  created_at: string;
  updated_at: string;
};

function percent(n: number, total: number): string {
  if (!total) return '—';
  return `${Math.round((n / total) * 100)}%`;
}

function ProgressBar({
  value,
  total,
  color,
}: {
  value: number;
  total: number;
  color: string;
}) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-9 text-right text-xs tabular-nums">
        {percent(value, total)}
      </span>
      <div className="bg-muted h-1.5 w-16 overflow-hidden rounded-full">
        <div className={`h-1.5 rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function ReportsPage() {
  const [reports, setReports] = useState<BroadcastReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [templateFilter, setTemplateFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [broadcastFilter, setBroadcastFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const buildParams = useCallback(() => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (templateFilter) params.set('template_name', templateFilter);
    if (statusFilter) params.set('status', statusFilter);
    if (broadcastFilter) params.set('broadcast_name', broadcastFilter);
    return params;
  }, [from, to, templateFilter, statusFilter, broadcastFilter]);

  async function fetchReports() {
    setLoading(true);
    setError(null);
    try {
      const params = buildParams();
      const res = await fetch(`/api/reports?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load reports');
      setReports(data.reports ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reports');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function downloadCsv(broadcastId?: string) {
    if (broadcastId) {
      // Per-broadcast recipient CSV
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broadcast_id: broadcastId, format: 'csv' }),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `broadcast-${broadcastId.slice(0, 8)}-recipients.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      // Summary CSV
      const params = buildParams();
      params.set('format', 'csv');
      params.set('limit', '1000');
      window.open(`/api/reports?${params.toString()}`, '_blank');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground">
            <BarChart2 className="h-6 w-6" />
            Reports
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Broadcast delivery metrics — filter by date, template, status, or campaign name.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => downloadCsv()}>
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <Input
            type="date"
            placeholder="From date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-40"
          />
        </div>
        <div className="relative">
          <Input
            type="date"
            placeholder="To date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-40"
          />
        </div>
        <div className="relative">
          <Search className="text-muted-foreground absolute left-2.5 top-2.5 h-4 w-4" />
          <Input
            placeholder="Template name"
            value={templateFilter}
            onChange={(e) => setTemplateFilter(e.target.value)}
            className="pl-8 w-44"
          />
        </div>
        <div className="relative">
          <Search className="text-muted-foreground absolute left-2.5 top-2.5 h-4 w-4" />
          <Input
            placeholder="Broadcast name"
            value={broadcastFilter}
            onChange={(e) => setBroadcastFilter(e.target.value)}
            className="pl-8 w-44"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border-input bg-background text-foreground h-9 rounded-md border px-3 py-1 text-sm"
        >
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="scheduled">Scheduled</option>
          <option value="sending">Sending</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
        </select>
        <Button size="sm" onClick={() => void fetchReports()}>
          Apply filters
        </Button>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
        </div>
      ) : error ? (
        <p className="text-destructive text-sm">{error}</p>
      ) : reports.length === 0 ? (
        <p className="text-muted-foreground py-12 text-center text-sm">No broadcasts match your filters.</p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-6" />
                <TableHead>Broadcast</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead>Delivered</TableHead>
                <TableHead>Read</TableHead>
                <TableHead>Failed</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Export</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((row) => (
                <>
                  <TableRow
                    key={row.id}
                    className="cursor-pointer"
                    onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                  >
                    <TableCell>
                      {expandedId === row.id ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </TableCell>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {row.template_name}
                      <span className="ml-1 opacity-60">({row.template_language})</span>
                    </TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        row.status === 'sent' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                        row.status === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                        row.status === 'sending' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' :
                        'bg-muted text-muted-foreground'
                      }`}>
                        {row.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.total_recipients ?? 0}
                    </TableCell>
                    <TableCell>
                      <ProgressBar value={row.sent_count ?? 0} total={row.total_recipients ?? 0} color="bg-primary" />
                    </TableCell>
                    <TableCell>
                      <ProgressBar value={row.delivered_count ?? 0} total={row.total_recipients ?? 0} color="bg-emerald-500" />
                    </TableCell>
                    <TableCell>
                      <ProgressBar value={row.read_count ?? 0} total={row.total_recipients ?? 0} color="bg-sky-500" />
                    </TableCell>
                    <TableCell>
                      <ProgressBar value={row.failed_count ?? 0} total={row.total_recipients ?? 0} color="bg-destructive" />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs tabular-nums">
                      {new Date(row.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Export recipients CSV"
                        onClick={(e) => {
                          e.stopPropagation();
                          void downloadCsv(row.id);
                        }}
                      >
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                  {expandedId === row.id && (
                    <TableRow key={`${row.id}-detail`}>
                      <TableCell colSpan={11} className="bg-muted/30 px-6 py-3">
                        <div className="grid grid-cols-5 gap-4 text-sm">
                          <div>
                            <p className="text-muted-foreground text-xs">Delivered rate</p>
                            <p className="font-semibold">{percent(row.delivered_count ?? 0, row.total_recipients ?? 0)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground text-xs">Read rate</p>
                            <p className="font-semibold">{percent(row.read_count ?? 0, row.total_recipients ?? 0)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground text-xs">Reply rate</p>
                            <p className="font-semibold">{percent(row.replied_count ?? 0, row.total_recipients ?? 0)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground text-xs">Failure rate</p>
                            <p className="font-semibold text-destructive">{percent(row.failed_count ?? 0, row.total_recipients ?? 0)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground text-xs">Last updated</p>
                            <p className="font-semibold text-xs">{new Date(row.updated_at).toLocaleString()}</p>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
