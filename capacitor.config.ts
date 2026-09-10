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
    // The web shell already applies env(safe-area-inset-*) to its chrome.
    // Capacitor disables WKWebView bounce; avoid adding a second native inset.
    contentInset: 'never',
    limitsNavigationsToAppBoundDomains: false,
    scheme: 'FSN',
    backgroundColor: '#0b0d10'
  },
  plugins: {
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] }
  },
  server: {
    // Local file:// serving inside WKWebView. No live-reload URL.
    iosScheme: 'capacitor',
    androidScheme: 'https',
    // Provider APIs use fetch; navigation must stay inside the bundled app.
    // Policies and Support open through the Capacitor Browser plugin.
    allowNavigation: []
  }
};

export default config;
