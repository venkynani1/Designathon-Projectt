'use client';
import { useRef, useState } from 'react';
import { ApiError, download } from '@/components/api';
import { Alert, Button } from '@/components/ui';

interface Result { booked: number; listed: number; skipped: { line: number; employee_id: string | null; name: string | null; problem: string }[] }

/** Offline registrations: Employee ID, Employee Name, Veg/Non-veg, Goodie — booked straight away. */
export function OfflineUpload() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [res, setRes] = useState<Result | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  async function upload(file: File) {
    setBusy(true); setErr(''); setRes(null);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await fetch('/api/admin/offline/import', { method: 'POST', body: fd, credentials: 'same-origin' });
      const j = await r.json();
      if (!r.ok) throw new ApiError(j?.error?.code ?? 'HTTP', j?.error?.message ?? 'Upload failed', r.status);
      setRes(j);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Upload failed'); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button busy={busy} onClick={() => ref.current?.click()}>Upload offline registrations</Button>
        <Button variant="secondary" onClick={() => download('/api/admin/offline/template').catch((e) => setErr(e.message))}>Download Excel template</Button>
        <input ref={ref} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }} />
      </div>
      <p className="text-xs text-slate-500">Columns: <strong>Employee ID</strong>, <strong>Employee Name</strong>, <strong>Veg/Non-veg</strong>, <strong>Goodie</strong>. The template has drop-downs with your current goodie names.</p>
      {err && <Alert>{err}</Alert>}
      {res && (
        <>
          <Alert tone="green">{res.booked} booked with a goodie{res.listed ? ` · ${res.listed} added without a goodie (they can pick with the goodies QR)` : ''}{res.skipped.length ? ` · ${res.skipped.length} rows need attention` : ''}</Alert>
          {res.skipped.length > 0 && (
            <div className="max-h-56 overflow-auto rounded-xl bg-amber-50 p-3 text-sm ring-1 ring-amber-200">
              <ul className="space-y-0.5 text-amber-900">
                {res.skipped.map((s) => <li key={s.line}>Row {s.line + 1}: {s.employee_id || '(no ID)'} {s.name ? `· ${s.name}` : ''} — {s.problem}</li>)}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
