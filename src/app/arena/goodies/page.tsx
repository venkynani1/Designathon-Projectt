import { redirect } from 'next/navigation';

/** The goodies arena is now the no-PIN survey. Old links and QR codes keep working. */
export default function Page() {
  redirect('/goodies');
}
