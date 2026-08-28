import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'FSN — Fantasy Sports Network',
  description:
    'Turn your fantasy league into a professional sports network with automated league journalism, franchise dossiers, historical records, and advanced analytics.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
