'use client';
import { useRef, useState } from 'react';
import { ApiError, download } from '@/components/api';
import { Alert, Button } from '@/components/ui';

export interface ImportResult { imported: number; teams: number; skipped: { line: number; employee_id: string | null; name: string | null; problem: string }[] }

/** Upload the team file (Employee ID, Employee Name, Team Name), with an Excel template. */
export function TeamsUpload({ onDone, replace = false, confirmReplace }: { onDone?: (r: ImportResult) => void; replace?: boolean; confirmReplace?: () => boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [drag, setDrag] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    if (replace && confirmReplace && !confirmReplace()) return;
    setBusy(true); setErr(''); setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (replace) fd.append('replace', '1');
      const res = await fetch('/api/admin/teams/import', { method: 'POST', body: fd, credentials: 'same-origin' });
      const j = await res.json();
      if (!res.ok) throw new ApiError(j?.error?.code ?? 'HTTP', j?.error?.message ?? 'Upload failed', res.status);
      setResult(j); onDone?.(j);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Upload failed'); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) upload(f); }}
        className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition ${drag ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-slate-50'}`}>
        <p className="text-3xl">📄</p>
        <p className="text-sm text-slate-600">Drag the Excel file here, or</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button busy={busy} onClick={() => ref.current?.click()}>Choose file</Button>
          <Button variant="secondary" onClick={() => download('/api/admin/teams/template').catch((e) => setErr(e.message))}>Download Excel template</Button>
        </div>
        <p className="text-xs text-slate-500">Three columns: <strong>Employee ID</strong>, <strong>Employee Name</strong>, <strong>Team Name</strong></p>
        <input ref={ref} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }} />
      </div>
      {err && <Alert>{err}</Alert>}
      {result && (
        <>
          <Alert tone="green">{result.imported} people imported · {result.teams} teams{result.skipped.length ? ` · ${result.skipped.length} rows skipped` : ''}</Alert>
          {result.skipped.length > 0 && (
            <div className="max-h-48 overflow-auto rounded-xl bg-amber-50 p-3 text-sm ring-1 ring-amber-200">
              <p className="mb-1 font-semibold text-amber-900">Skipped rows — fix them in the file and upload again:</p>
              <ul className="space-y-0.5 text-amber-900">
                {result.skipped.map((s) => <li key={s.line}>Row {s.line + 1}: {s.employee_id || '(no ID)'} {s.name ? `· ${s.name}` : ''} — {s.problem}</li>)}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
