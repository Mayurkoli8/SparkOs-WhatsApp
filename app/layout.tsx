import './globals.css';

export const metadata = {
  title: 'Spark WhatsApp Bridge',
  description: 'Self-hosted WhatsApp bridge for HighLevel'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
