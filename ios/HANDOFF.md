# FSN iOS — Capacitor handoff

Everything below the "Manual steps in Xcode" heading requires a Mac with
Xcode 15+, an Apple Developer account, and App Store Connect access.
Everything above it is scriptable and reproducible on any machine with
Node 18+ and CocoaPods.

---

## 1. One-time setup (per fresh clone on a Mac)

```bash
# From the repo root.
npm install

# Adds the native iOS project at ./ios/. Only run this once per repo —
# after the first run, `ios/` is committed and every subsequent clone
# skips straight to `npm run ios:sync`.
npx cap add ios

# Install CocoaPods deps for the generated Xcode project.
cd ios/App && pod install && cd ../..
```

## 2. Generate app icons and launch images

Drop your source PNGs into `assets/` (see `assets/README.md` for the exact
sizes), then:

```bash
npm run ios:assets
```

This overwrites `ios/App/App/Assets.xcassets/AppIcon.appiconset/` and
`Splash.imageset/` in place.

## 3. Build + sync + open Xcode

Copy-paste-runnable script — this is the loop you'll run for every code
change to `index.html` or `editorialScheduleEngine.js`:

```bash
# Stage the web app into www/ (the Capacitor webDir).
npm run build:ios

# Copy www/ into ios/App/App/public/ and re-link native plugins.
npx cap sync ios

# Open the Xcode workspace.
npx cap open ios
```

Or, condensed:

```bash
npm run ios:sync && npm run ios:open
```

---

## Manual steps in Xcode

Once `npx cap open ios` opens `App.xcworkspace`:

1. **Select the `App` target** in the left sidebar → **Signing & Capabilities**.
2. **Verify Bundle Identifier** reads exactly `app.fantasysportsnetwork`.
   If it differs, either change it here or re-run `npx cap sync` after
   correcting `capacitor.config.ts`.
3. **Team Signing** — set **Team** to the Apple Developer team that owns
   the `app.fantasysportsnetwork` App ID. Leave **Automatically manage
   signing** checked unless the team uses manual provisioning profiles.
4. **General → Deployment Info** — confirm minimum iOS version (Capacitor 6
   defaults to iOS 13.0; App Store currently requires 12.0+).
5. **Version + Build** — bump `CFBundleShortVersionString` (marketing
   version) and `CFBundleVersion` (build number) on every archive.
6. **Product → Destination → Any iOS Device (arm64)**. Archiving against a
   simulator is rejected by App Store Connect.
7. **Product → Archive**. Wait for the archive to appear in the Organizer.
8. In **Organizer**, select the new archive → **Distribute App** →
   **App Store Connect** → **Upload**. Follow the signing prompts.
9. In **App Store Connect** (browser), the build appears under
   TestFlight → Builds within ~15 minutes. Add it to a test group or
   submit for review from there.

---

## Info.plist snippets

`npx cap add ios` scaffolds a minimal `Info.plist`. The keys below are
NOT added by default and must be inserted manually into
`ios/App/App/Info.plist` before the first App Store submission, otherwise
the review team will reject the binary or the WKWebView will silently
block resources.

### Required — network access to ESPN, Supabase, Vercel

Modern WKWebView allows arbitrary HTTPS by default, but the review team
still checks these keys when they see network calls. Add explicitly:

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsArbitraryLoads</key>
    <false/>
    <key>NSExceptionDomains</key>
    <dict>
        <key>espn.com</key>
        <dict>
            <key>NSIncludesSubdomains</key>
            <true/>
            <key>NSExceptionAllowsInsecureHTTPLoads</key>
            <false/>
        </dict>
        <key>supabase.co</key>
        <dict>
            <key>NSIncludesSubdomains</key>
            <true/>
        </dict>
        <key>vercel.app</key>
        <dict>
            <key>NSIncludesSubdomains</key>
            <true/>
        </dict>
    </dict>
</dict>
```

### Required — UI orientation (portrait-only, matching the web app)

```xml
<key>UISupportedInterfaceOrientations</key>
<array>
    <string>UIInterfaceOrientationPortrait</string>
</array>
<key>UISupportedInterfaceOrientations~ipad</key>
<array>
    <string>UIInterfaceOrientationPortrait</string>
    <string>UIInterfaceOrientationPortraitUpsideDown</string>
</array>
```

### Required — status bar style (light content on the dark theme)

```xml
<key>UIStatusBarStyle</key>
<string>UIStatusBarStyleLightContent</string>
<key>UIViewControllerBasedStatusBarAppearance</key>
<false/>
```

### Optional — add only if the corresponding feature is actually wired up

The current web app does NOT use camera, mic, photo library, location,
push notifications, or contacts. Do NOT paste these until the feature
ships — Apple rejects binaries that declare unused permissions.

```xml
<!-- Only if a "share screenshot" feature is added -->
<key>NSPhotoLibraryAddUsageDescription</key>
<string>FSN saves league graphics to your Photos.</string>

<!-- Only if push notifications are added -->
<key>UIBackgroundModes</key>
<array>
    <string>remote-notification</string>
</array>
```

---

## Updating the app after the first release

For every subsequent release:

```bash
git pull
npm run ios:sync
npx cap open ios
```

Then in Xcode: bump build number → Product → Archive → Distribute.
