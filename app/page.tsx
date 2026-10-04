import { redirect } from 'next/navigation';

// No sign-in yet: the root opens the admin dashboard. Sub-accounts use /subaccount/<locationId>.
export default function Home() {
  redirect('/admin');
}
