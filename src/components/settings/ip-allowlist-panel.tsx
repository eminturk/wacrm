'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Shield, Trash2, Loader2, AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RequireRole } from '@/components/auth/require-role';
import { SettingsPanelHead } from './settings-panel-head';

export function IpAllowlistPanel() {
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newEntry, setNewEntry] = useState('');

  const fetchAllowlist = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/account/ip-allowlist');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load');
      setAllowlist(data.ip_allowlist ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load IP allowlist');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAllowlist();
  }, [fetchAllowlist]);

  async function save(list: string[]) {
    setSaving(true);
    try {
      const res = await fetch('/api/account/ip-allowlist', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip_allowlist: list }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save');
      }
      setAllowlist(data.ip_allowlist ?? list);
      toast.success('IP allowlist updated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save IP allowlist');
    } finally {
      setSaving(false);
    }
  }

  function addEntry() {
    const entry = newEntry.trim();
    if (!entry) return;
    if (allowlist.includes(entry)) {
      toast.error('This IP/CIDR is already in the list');
      return;
    }
    const next = [...allowlist, entry];
    setAllowlist(next);
    setNewEntry('');
  }

  function removeEntry(entry: string) {
    setAllowlist((prev) => prev.filter((e) => e !== entry));
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="IP Allowlist"
        description="Restrict account access to specific IP addresses or CIDR ranges. An empty list allows all IPs."
      />

      {allowlist.length > 0 && (
        <Card className="mb-4 border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/20">
          <CardContent className="flex gap-3 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="text-amber-800 dark:text-amber-300">
              Active. Only listed IPs can access this account. Make sure your IP
              is included before saving.
            </span>
          </CardContent>
        </Card>
      )}

      <RequireRole min="owner" fallback={
        <p className="text-muted-foreground text-sm">Only the account owner can manage the IP allowlist.</p>
      }>
        <div className="space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 py-4">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-muted-foreground text-sm">Loading…</span>
            </div>
          ) : (
            <>
              {allowlist.length === 0 ? (
                <p className="text-muted-foreground rounded-md border border-dashed px-4 py-6 text-center text-sm">
                  No IP restrictions — all IPs may access this account.
                </p>
              ) : (
                <div className="space-y-2">
                  {allowlist.map((entry) => (
                    <div
                      key={entry}
                      className="bg-muted/40 flex items-center justify-between rounded-md px-3 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <Shield className="text-muted-foreground h-4 w-4" />
                        <span className="font-mono text-sm">{entry}</span>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => removeEntry(entry)}
                        aria-label={`Remove ${entry}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <div className="flex-1">
                  <Label htmlFor="new-ip" className="sr-only">
                    Add IP address or CIDR range
                  </Label>
                  <Input
                    id="new-ip"
                    placeholder="e.g. 203.0.113.0/24 or 192.168.1.1"
                    value={newEntry}
                    onChange={(e) => setNewEntry(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addEntry();
                      }
                    }}
                    className="font-mono"
                  />
                </div>
                <Button variant="outline" onClick={addEntry}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add
                </Button>
              </div>

              <div className="flex justify-end gap-2 border-t pt-4">
                <Button
                  variant="outline"
                  onClick={() => void fetchAllowlist()}
                  disabled={saving}
                >
                  Discard changes
                </Button>
                <Button onClick={() => void save(allowlist)} disabled={saving}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save allowlist
                </Button>
              </div>
            </>
          )}
        </div>
      </RequireRole>
    </section>
  );
}
