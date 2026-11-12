import { AuditLog } from '@/components/admin/AuditLog';

export default async function Page({ searchParams }: { searchParams: Promise<{ entity?: string }> }) {
  const { entity } = await searchParams;
  return <AuditLog entity={entity ?? null} />;
}
