/** Public survey address: NEXT_PUBLIC_APP_URL if set, otherwise derived from the request host. */
export function surveyUrl(headers: Headers): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '')
    || `${headers.get('x-forwarded-proto') ?? 'https'}://${headers.get('x-forwarded-host') ?? headers.get('host')}`;
  return `${base}/goodies`;
}
