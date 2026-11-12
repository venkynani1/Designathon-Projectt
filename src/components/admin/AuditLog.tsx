'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/components/api';
import { Alert, Badge, Card } from '@/components/ui';

interface Entry { id: number; actor_type: string; actor_id: string | null; action: string; entity_type: string | null; entity_id: string | null; reason: string | null; details: Record<string, unknown> | null; created_at: string }

export function AuditLog({ entity }: { entity: string | null }) {
  const [rows, setRows] = useState<Entry[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => { api<{ entries: Entry[] }>(`/api/admin/audit${entity ? `?entity=${entity}` : ''}`).then((r) => setRows(r.entries)).catch((e) => setErr(e.message)); }, [entity]);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-black">Audit log</h1>
        {entity && <><Badge tone="blue">filtered</Badge><Link className="text-sm text-brand-700 hover:underline" href="/admin/audit">show all</Link></>}
      </div>
      {err && <Alert>{err}</Alert>}
      <Card className="!p-0">
        <ul className="divide-y">
          {rows.map((r) => (
            <li key={r.id} className="grid gap-1 px-4 py-3 text-sm md:grid-cols-[11rem_14rem_1fr]">
              <span className="text-slate-500">{new Date(r.created_at).toLocaleString()}</span>
              <span><Badge tone={r.action.includes('privileged') || r.action.includes('reissued') ? 'amber' : 'slate'}>{r.action}</Badge> <span className="text-xs text-slate-500">{r.actor_type}</span></span>
              <span className="break-all text-slate-700">
                {r.reason && <strong className="mr-2">“{r.reason}”</strong>}
                <code className="text-xs text-slate-500">{r.details ? JSON.stringify(r.details) : ''}</code>
              </span>
            </li>
          ))}
          {rows.length === 0 && <li className="px-4 py-8 text-center text-slate-500">No entries.</li>}
        </ul>
      </Card>
    </div>
  );
}
