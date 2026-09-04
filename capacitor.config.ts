import type { CapacitorConfig } from '@capacitor/cli';

// FSN — Capacitor wrapper config for the native iOS binary.
// index.html is a static single-file app served by Vercel on the web.
// For iOS we stage the same file (plus editorialScheduleEngine.js) into
// `www/` via `npm run build:ios`, then Capacitor copies `www/` into the
// Xcode project's public folder on `npx cap sync`.
const config: CapacitorConfig = {
  appId: 'app.fantasysportsnetwork',
  appName: 'FSN',
  webDir: 'www',
  bundledWebRuntime: false,
  ios: {
    contentInset: 'always',
    limitsNavigationsToAppBoundDomains: false,
    scheme: 'FSN',
    backgroundColor: '#0b0d10'
  },
  server: {
    // Local file:// serving inside WKWebView. No live-reload URL.
    iosScheme: 'capacitor',
    androidScheme: 'https',
    // ESPN + Supabase + Vercel proxies are already CORS-cleared by the
    // web build; nothing to allowlist here beyond the app's own scheme.
    allowNavigation: [
      '*.espn.com',
      '*.supabase.co',
      '*.vercel.app',
      'fantasysportsnetwork.app'
    ]
  }
};

export default config;
