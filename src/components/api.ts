'use client';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

async function fail(res: Response): Promise<never> {
  const j = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  throw new ApiError(j?.error?.code ?? 'HTTP', j?.error?.message ?? res.statusText, res.status);
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!res.ok) await fail(res);
  return (await res.json()) as T;
}

/** POSTs and downloads a binary response (PDF/XLSX) without exposing it via a GET URL. */
export async function download(path: string, body?: unknown): Promise<{ missing: number }> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (!res.ok) await fail(res);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'download';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return { missing: Number(res.headers.get('x-missing-pins') ?? 0) };
}
