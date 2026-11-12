import Link from 'next/link';

export default function Home() {
  const tiles = [
    { href: '/arena/problems', title: 'Problem Statement Arena', body: 'Team login with your Team PIN. Pick and lock one challenge for your team.', cta: 'Enter as a team' },
    { href: '/arena/goodies', title: 'Goodies Arena', body: 'Personal login with your employee ID and personal PIN. Reserve one goodie.', cta: 'Enter as a participant' },
  ];
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-5 py-12">
      <div>
        <p className="text-sm font-semibold uppercase tracking-widest text-brand-700">Designathon X</p>
        <h1 className="mt-2 text-4xl font-black tracking-tight">Welcome, designers.</h1>
        <p className="mt-2 text-slate-600">Use the credentials printed on your team slip. Keep your personal PIN private.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {tiles.map((t) => (
          <Link key={t.href} href={t.href} className="group rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 transition hover:-translate-y-0.5 hover:shadow-md hover:ring-brand-500">
            <h2 className="text-lg font-bold">{t.title}</h2>
            <p className="mt-2 text-sm text-slate-600">{t.body}</p>
            <span className="mt-4 inline-block text-sm font-semibold text-brand-700 group-hover:underline">{t.cta} →</span>
          </Link>
        ))}
      </div>
      <Link href="/admin" className="text-xs text-slate-400 hover:text-slate-600">Organizer console</Link>
    </main>
  );
}
