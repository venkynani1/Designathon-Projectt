'use client';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { browserClient } from '@/lib/supabase/browser';
import { Alert, Button, Card, Field } from '@/components/ui';

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    const { error } = await browserClient().auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return setErr('Sign-in failed. Check your email and password.');
    router.replace(next && next.startsWith('/admin') ? next : '/admin');
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <Field label="Work email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></Field>
      <Field label="Password"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></Field>
      {err && <Alert>{err}</Alert>}
      <Button className="w-full" busy={busy}>Sign in</Button>
    </form>
  );
}

export default function AdminLogin() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <p className="text-xs font-bold uppercase tracking-widest text-brand-700">Designathon X</p>
        <h1 className="text-2xl font-black">Organizer console</h1>
        <Suspense><LoginForm /></Suspense>
      </Card>
    </main>
  );
}
