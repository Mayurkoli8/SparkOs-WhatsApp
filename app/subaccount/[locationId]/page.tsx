import SubaccountView from './SubaccountView';

export const metadata = { title: 'WhatsApp' };

// Opened from a HighLevel Custom Menu Link: /subaccount/{{location.id}}
export default async function SubaccountPage({ params }: { params: Promise<{ locationId: string }> }) {
  const { locationId } = await params;
  return <SubaccountView locationId={locationId} />;
}
