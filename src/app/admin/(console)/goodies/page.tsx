'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/components/api';
import { Alert, Badge, Button, Field, Modal } from '@/components/ui';
import { useAdmin } from '@/components/admin/AdminContext';
import { ArenaBar } from '@/components/admin/ArenaBar';
import { GoodiesTabs } from '@/components/admin/GoodiesTabs';

interface Goodie { id: string; name: string; description: string | null; stock: number; image_url: string | null; has_photo: boolean; is_active: boolean; sort_order: number; reserved: number; collected: number }
type Draft = { id?: string; name: string; description: string; stock: number; is_active: boolean; sort_order?: number; preview: string | null; photo: { mime: string; data: string } | null; removePhoto?: boolean };
const empty: Draft = { name: '', description: '', stock: 50, is_active: true, preview: null, photo: null };

/** Shrinks a phone photo to ≤900px JPEG in the browser so it uploads fast and loads fast for participants. */
async function shrink(file: File): Promise<{ mime: string; data: string; preview: string }> {
  if (!file.type.startsWith('image/')) throw new Error('Please choose an image file');
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.82);
  return { mime: 'image/jpeg', data: url.split(',')[1], preview: url };
}

export default function GoodiesPage() {
  const admin = useAdmin();
  const [rows, setRows] = useState<Goodie[] | null>(null);
  const [edit, setEdit] = useState<Draft | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<{ goodies: Goodie[] }>('/api/admin/goodies').then((r) => setRows(r.goodies)).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  const canEdit = admin.atLeast('admin');

  async function save() {
    if (!edit) return;
    setBusy(true); setErr('');
    try {
      const { id } = await api<{ id: string }>('/api/admin/goodies', {
        body: { id: edit.id, name: edit.name, description: edit.description || null, stock: edit.stock, is_active: edit.is_active, sort_order: edit.sort_order, image_url: null },
      });
      if (edit.photo) await api(`/api/admin/goodies/${id}/photo`, { body: edit.photo });
      else if (edit.removePhoto) await api(`/api/admin/goodies/${id}/photo`, { method: 'DELETE' });
      setMsg(edit.id ? 'Saved.' : 'Goodie added.');
      setEdit(null);
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(false); }
  }
  async function quick(g: Goodie, patch: Partial<Draft>, done: string) {
    setErr(''); setMsg('');
    try { await api('/api/admin/goodies', { body: { id: g.id, name: g.name, description: g.description, stock: g.stock, is_active: g.is_active, sort_order: g.sort_order, image_url: g.has_photo ? null : g.image_url, ...patch } }); setMsg(done); await load(); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
  }
  async function remove(g: Goodie) {
    if (!window.confirm(`Delete ${g.name}? This cannot be undone.`)) return;
    setErr(''); setMsg('');
    try { await api(`/api/admin/goodies/${g.id}`, { method: 'DELETE' }); setMsg('Deleted.'); await load(); } catch (e) { setErr(e instanceof Error ? e.message : 'Failed'); }
  }

  const total = rows?.filter((g) => g.is_active).reduce((s, g) => s + g.stock, 0) ?? 0;
  const reserved = rows?.reduce((s, g) => s + g.reserved, 0) ?? 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-black">Goodies</h1>
        {canEdit && <Button onClick={() => { setErr(''); setEdit({ ...empty }); }}>+ Add goodie</Button>}
      </div>
      <GoodiesTabs />
      <ArenaBar arena="goodies" />
      {msg && <Alert tone="green">{msg}</Alert>}
      {err && <Alert>{err}</Alert>}
      {rows && <p className="text-sm text-slate-600">{total} items in total · {reserved} chosen · {total - reserved} left</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows?.map((g) => {
          const left = g.stock - g.reserved;
          return (
            <div key={g.id} className={`rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200 ${g.is_active ? '' : 'opacity-60'}`}>
              {g.image_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={g.image_url} alt="" className="mb-3 h-32 w-full rounded-xl object-cover" />
              )}
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-bold">{g.name}</h2>
                {!g.is_active ? <Badge>Hidden</Badge> : <Badge tone={left <= 0 ? 'red' : left < g.stock * 0.15 ? 'amber' : 'green'}>{left} left</Badge>}
              </div>
              {g.description && <p className="mt-1 text-sm text-slate-600">{g.description}</p>}
              <div className="mt-2 h-1.5 overflow-hidden rounded bg-slate-100"><div className="h-full bg-brand-500" style={{ width: `${g.stock ? (g.reserved / g.stock) * 100 : 0}%` }} /></div>
              <p className="mt-1 text-xs text-slate-500">{g.reserved} chosen of {g.stock}{g.collected ? ` · ${g.collected} collected` : ''}</p>
              {canEdit && (
                <div className="mt-3 flex flex-wrap gap-1">
                  <Button variant="secondary" onClick={() => { setErr(''); setEdit({ ...g, description: g.description ?? '', preview: g.image_url, photo: null }); }}>Edit</Button>
                  <Button variant="secondary" onClick={() => quick(g, { is_active: !g.is_active }, g.is_active ? 'Hidden from participants.' : 'Visible to participants.')}>{g.is_active ? 'Hide' : 'Show'}</Button>
                  {g.reserved === 0 && <Button variant="ghost" className="text-rose-700" onClick={() => remove(g)}>Delete</Button>}
                </div>
              )}
            </div>
          );
        })}
        {rows && rows.length === 0 && <p className="rounded-2xl bg-white p-8 text-center text-slate-500 ring-1 ring-slate-200 sm:col-span-2 lg:col-span-3">No goodies yet. Add the first one.</p>}
      </div>

      <Modal open={!!edit} title={edit?.id ? `Edit ${edit.name}` : 'Add goodie'} onClose={() => setEdit(null)}>
        {edit && (
          <form onSubmit={(e) => { e.preventDefault(); save(); }} className="space-y-3">
            <div className="grid grid-cols-[1fr_8rem] gap-3">
              <Field label="Name"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required maxLength={80} /></Field>
              <Field label="Quantity"><input className="input" type="number" min={0} max={100000} value={edit.stock} onChange={(e) => setEdit({ ...edit, stock: Number(e.target.value) })} required /></Field>
            </div>
            <Field label="Description (optional)"><input className="input" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} maxLength={500} /></Field>
            <Field label="Photo" hint="Take a photo or choose one — it is resized automatically">
              <div className="flex items-center gap-3">
                <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-slate-100 ring-1 ring-slate-200">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {edit.preview ? <img src={edit.preview} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-2xl text-slate-300">🎁</div>}
                </div>
                <div className="flex flex-col items-start gap-1">
                  <label className="cursor-pointer rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-semibold hover:bg-slate-200">
                    {edit.preview ? 'Change photo' : 'Upload photo'}
                    <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                      const f = e.target.files?.[0]; e.target.value = '';
                      if (!f) return;
                      try { const p = await shrink(f); setEdit((d) => d && { ...d, photo: { mime: p.mime, data: p.data }, preview: p.preview, removePhoto: false }); }
                      catch (x) { setErr(x instanceof Error ? x.message : 'Could not read that image'); }
                    }} />
                  </label>
                  {edit.preview && <button type="button" className="text-xs text-rose-700 hover:underline" onClick={() => setEdit({ ...edit, photo: null, preview: null, removePhoto: true })}>Remove photo</button>}
                </div>
              </div>
            </Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> Visible to participants</label>
            {err && <Alert>{err}</Alert>}
            <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button busy={busy}>Save</Button></div>
          </form>
        )}
      </Modal>
    </div>
  );
}
