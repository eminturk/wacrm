'use client';

import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { ShieldCheck, ShieldOff, Loader2, Copy, CheckCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

type MfaStatus = { mfaEnabled: boolean; hasPendingSecret: boolean } | null;

export function MfaCard() {
  const [status, setStatus] = useState<MfaStatus>(null);
  const [loading, setLoading] = useState(true);

  // Setup state
  const [setupOpen, setSetupOpen] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [setupUri, setSetupUri] = useState<string | null>(null);
  const [confirmCode, setConfirmCode] = useState('');
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  // Disable state
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableCode, setDisableCode] = useState('');
  const [disableLoading, setDisableLoading] = useState(false);

  useEffect(() => {
    fetch('/api/auth/mfa/setup')
      .then((r) => r.json())
      .then((d) => setStatus(d as MfaStatus))
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
  }, []);

  const startSetup = async () => {
    setConfirmCode('');
    setQrDataUrl(null);
    setRecoveryCodes(null);
    setSetupOpen(true);
    const res = await fetch('/api/auth/mfa/setup', { method: 'POST' });
    const data = (await res.json()) as { qrDataUrl?: string; uri?: string; error?: string };
    if (!res.ok) {
      toast.error(data.error ?? 'Failed to start MFA setup');
      setSetupOpen(false);
      return;
    }
    setQrDataUrl(data.qrDataUrl ?? null);
    setSetupUri(data.uri ?? null);
  };

  const confirmSetup = async () => {
    setConfirmLoading(true);
    const res = await fetch('/api/auth/mfa/setup/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: confirmCode }),
    });
    const data = (await res.json()) as { ok?: boolean; recoveryCodes?: string[]; error?: string };
    setConfirmLoading(false);
    if (!res.ok) {
      toast.error(data.error ?? 'Confirmation failed');
      return;
    }
    setRecoveryCodes(data.recoveryCodes ?? []);
    setStatus({ mfaEnabled: true, hasPendingSecret: false });
  };

  const copyRecoveryCodes = () => {
    if (!recoveryCodes) return;
    navigator.clipboard.writeText(recoveryCodes.join('\n')).then(() => {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 2000);
    });
  };

  const disableMfa = async () => {
    setDisableLoading(true);
    const res = await fetch('/api/auth/mfa/disable', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: disableCode }),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    setDisableLoading(false);
    if (!res.ok) {
      toast.error(data.error ?? 'Failed to disable MFA');
      return;
    }
    toast.success('MFA has been disabled');
    setDisableOpen(false);
    setDisableCode('');
    setStatus({ mfaEnabled: false, hasPendingSecret: false });
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex h-24 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            {status?.mfaEnabled ? (
              <ShieldCheck className="size-4 text-primary" />
            ) : (
              <ShieldOff className="size-4 text-muted-foreground" />
            )}
            Two-factor authentication
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {status?.mfaEnabled
              ? 'MFA is active. A TOTP code is required at every sign-in.'
              : 'Add a second layer of security using an authenticator app (Google Authenticator, Authy, etc.).'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {status?.mfaEnabled ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setDisableOpen(true)}
              className="border-red-500/30 text-red-400 hover:bg-red-500/10"
            >
              <ShieldOff className="size-4" />
              Disable MFA
            </Button>
          ) : (
            <Button type="button" onClick={startSetup}>
              <ShieldCheck className="size-4" />
              Enable MFA
            </Button>
          )}
        </CardContent>
      </Card>

      {/* ---- Setup dialog ---- */}
      <Dialog open={setupOpen} onOpenChange={(v) => { if (!v && !recoveryCodes) setSetupOpen(false) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Set up two-factor authentication</DialogTitle>
            <DialogDescription>
              {recoveryCodes
                ? 'Save these recovery codes somewhere safe. Each code can only be used once.'
                : 'Scan the QR code with your authenticator app, then enter the 6-digit code to confirm.'}
            </DialogDescription>
          </DialogHeader>

          {recoveryCodes ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-border bg-muted p-4 font-mono text-sm">
                {recoveryCodes.map((code) => (
                  <div key={code} className="text-foreground">
                    {code}
                  </div>
                ))}
              </div>
              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={copyRecoveryCodes}
              >
                {copiedAll ? (
                  <CheckCheck className="size-4 text-primary" />
                ) : (
                  <Copy className="size-4" />
                )}
                {copiedAll ? 'Copied!' : 'Copy all codes'}
              </Button>
              <DialogFooter>
                <Button
                  onClick={() => setSetupOpen(false)}
                  className="w-full"
                >
                  Done — I have saved my codes
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              {qrDataUrl ? (
                <div className="flex justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qrDataUrl} alt="TOTP QR code" className="h-48 w-48 rounded-lg" />
                </div>
              ) : (
                <div className="flex h-48 items-center justify-center">
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
              )}
              {setupUri && (
                <p className="break-all text-center text-xs text-muted-foreground">
                  Can&apos;t scan?{' '}
                  <button
                    type="button"
                    className="text-primary underline"
                    onClick={() => navigator.clipboard.writeText(setupUri)}
                  >
                    Copy setup key
                  </button>
                </p>
              )}
              <div className="flex flex-col gap-2">
                <Label className="text-muted-foreground">Verification code</Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  placeholder="000000"
                  maxLength={6}
                  value={confirmCode}
                  onChange={(e) => setConfirmCode(e.target.value)}
                  className="text-center text-xl tracking-widest"
                />
              </div>
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => setSetupOpen(false)}
                  disabled={confirmLoading}
                >
                  Cancel
                </Button>
                <Button
                  onClick={confirmSetup}
                  disabled={confirmLoading || confirmCode.length < 6}
                >
                  {confirmLoading ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Confirming…
                    </>
                  ) : (
                    'Confirm & enable'
                  )}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ---- Disable dialog ---- */}
      <Dialog open={disableOpen} onOpenChange={setDisableOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable two-factor authentication?</DialogTitle>
            <DialogDescription>
              Enter your current TOTP code (or a recovery code) to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label className="text-muted-foreground">TOTP / recovery code</Label>
            <Input
              type="text"
              placeholder="000000 or RECOVERY-CODE"
              value={disableCode}
              onChange={(e) => setDisableCode(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDisableOpen(false)} disabled={disableLoading}>
              Cancel
            </Button>
            <Button
              onClick={disableMfa}
              disabled={disableLoading || !disableCode.trim()}
              variant="destructive"
            >
              {disableLoading ? <Loader2 className="size-4 animate-spin" /> : 'Disable MFA'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
