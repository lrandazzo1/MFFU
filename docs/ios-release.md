# FSN iOS — cloud builds via GitHub Actions

`.github/workflows/ios-build.yml` compiles, signs, exports and uploads the
Capacitor iOS app on a hosted macOS runner. No Mac, no Xcode, and no local
CocoaPods install are required.

It runs on every push to `main` and on demand from **Actions → iOS Build →
Run workflow**.

---

## What the workflow does

| # | Step | Notes |
|---|---|---|
| 1 | `npm ci` | Node 20, npm cache restored |
| 2 | `npm run check:scope` | The CLAUDE.md scope scan. Fails in seconds rather than after a 20-minute archive |
| 3 | `npm run build` | Stages `index.html`, `editorialScheduleEngine.js` and `notificationService.js` into `www/` |
| 4 | `npx cap add ios` | The native project is **not** committed, so it is regenerated per run. If `ios/App/App.xcodeproj` is ever committed, the workflow runs `npx cap sync ios` against it instead |
| 5 | `npm run ios:assets` | Only when `assets/icon.png` exists; otherwise the placeholder icon ships |
| 6 | `npm run ios:configure` | Re-applies everything Xcode would otherwise hold in the project — see below |
| 7 | `pod install` | CocoaPods, cached on the npm lockfile hash |
| 8 | `xcodebuild archive` | Release, `generic/platform=iOS` |
| 9 | `xcodebuild -exportArchive` | Writes the `.ipa` |
| 10 | `xcrun altool` | Validates, then uploads to App Store Connect |

Because step 4 regenerates the Xcode project from the Capacitor template every
run, **any change made by hand in Xcode would be discarded.** Step 6
(`scripts/ios-configure.mjs`) is where that configuration lives instead. It is
idempotent and sets:

- The `Info.plist` keys documented in `ios-handoff.md` — portrait-only
  orientation, light status bar, and the App Transport Security exception
  domains for ESPN, Supabase, Vercel and `fantasysportsnetwork.app`.
- `ITSAppUsesNonExemptEncryption = false`, so App Store Connect stops asking
  the export-compliance question on every build.
- `App.entitlements` with `aps-environment: production`, plus the
  `remote-notification` background mode, because `@capacitor/push-notifications`
  is a dependency and `notificationService.js` registers for APNs.
- Signing settings (team, style, identity, profile) on the **App target only** —
  never on the Pods targets.
- The marketing version and build number.
- A shared `App.xcscheme`. The Capacitor template ships none; Xcode writes one
  on first GUI open, which never happens on a headless runner, so
  `xcodebuild -scheme App` would otherwise have nothing to resolve.

---

## Required repository secrets

**Settings → Secrets and variables → Actions → Secrets → New repository secret.**

These four are required. The workflow fails fast with a named list if any are
missing.

| Secret | Where it comes from |
|---|---|
| `APPSTORE_CONNECT_KEY_ID` | App Store Connect → Users and Access → Integrations → App Store Connect API. The 10-character Key ID of the key you generate |
| `APPSTORE_CONNECT_ISSUER_ID` | Same page, shown above the key list. A UUID, identical for every key on the account |
| `APPSTORE_CONNECT_PRIVATE_KEY` | The `AuthKey_XXXXXXXXXX.p8` file downloaded when the key is created. **Apple lets you download it exactly once.** Paste the whole file including the `BEGIN`/`END` lines, or paste base64 of it — the workflow accepts either |
| `APPLE_TEAM_ID` | Apple Developer → Membership. 10 characters. The same value as `APNS_TEAM_ID` in `NOTIFICATIONS.md` |

Give the API key the **App Manager** role. A Developer-role key cannot create
provisioning profiles, so automatic signing fails.

### Optional — pin signing to an existing certificate

Leave these unset and the workflow uses automatic signing: Xcode fetches or
creates the distribution certificate and provisioning profile through the API
key. That is the path to use if you have no Mac, because exporting a `.p12`
normally requires Keychain Access.

Set **all three** to switch to manual signing against a certificate you already
have:

| Secret | Value |
|---|---|
| `IOS_DIST_CERT_P12` | base64 of your Apple Distribution `.p12` — `base64 -i cert.p12 \| pbcopy` |
| `IOS_DIST_CERT_PASSWORD` | The password set when exporting the `.p12` |
| `IOS_PROVISIONING_PROFILE` | base64 of the App Store `.mobileprovision` |
| `IOS_PROVISIONING_PROFILE_NAME` | The profile's name exactly as it appears in the Developer portal |

The certificate is imported into a throwaway keychain that is deleted when the
job ends, whether it passed or failed.

## Optional repository variables

**Settings → Secrets and variables → Actions → Variables.**

| Variable | Default | Effect |
|---|---|---|
| `IOS_AUTO_UPLOAD` | `true` | Set to `false` to archive and export on pushes to `main` without uploading to TestFlight. Manual runs use the checkbox instead |
| `IOS_ENABLE_PUSH` | `true` | Set to `false` to build without the push entitlement and background mode |
| `XCODE_VERSION` | runner default | Pin a version, e.g. `16.2`, to select `/Applications/Xcode_16.2.app` |

---

## One-time Apple setup

The workflow cannot do these; they are portal changes.

1. **App ID** — `app.fantasysportsnetwork` must exist under Certificates,
   Identifiers & Profiles, with the **Push Notifications** service enabled.
   The `aps-environment` entitlement has to be satisfied by the provisioning
   profile, so *the archive fails to sign if push is not enabled on the App
   ID.* Either enable it, or set `IOS_ENABLE_PUSH=false`.
2. **App record** — the app must exist in App Store Connect with the same
   bundle ID before the first upload, otherwise `altool` rejects it.
3. **Agreements** — Business → Agreements must all be active, or uploads fail
   with a contract error.

## Build numbers

`CFBundleVersion` is the GitHub Actions run number, so it increases on its own
and never collides. `CFBundleShortVersionString` comes from `version` in
`package.json` (currently `1.0.0`); bump that for a new marketing version, or
override either from the **Run workflow** form.

App Store Connect rejects a build whose number it has already seen. If you
re-run a failed job after a successful upload, pass a higher build number in
the form.

## Artifacts

Every run uploads the `.ipa`, the dSYMs (keep these — they symbolicate crash
reports for that exact build) and the `xcodebuild` logs. Logs are retained even
when the job fails, which is where to look first.

## Where a Mac is still needed

Nowhere, for building and shipping to TestFlight. Submitting for App Store
review, managing testers, and filling in store metadata are all browser tasks
in App Store Connect. `ios-handoff.md` documents the local Xcode loop for
anyone who does have a Mac.
