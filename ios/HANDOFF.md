# FSN iOS — Capacitor handoff

Native archiving, distribution signing and device checks require a Mac with
Xcode 26+, the Apple Developer team and App Store Connect access.

## 1. Native project and assets

The generated `ios/App/` project is not source-controlled. CI creates it on
macOS, restores the templates in `ios/`, stages the iOS-only HTML and syncs
Capacitor. On a fresh local checkout, use the same preparation sequence as
`.github/workflows/ios-build.yml` (the existing `ios/` directory must be moved
aside before `cap add ios`, then its templates restored).

The app icon is already supplied: `assets/icon.svg` is the outlined FSN master.
`npm run ios:assets` regenerates PNG sources and the Xcode asset catalogs and
checks that every icon is branded. Do not skip this after native generation.

For an existing generated project:

```bash
npm ci
npm run ios:sync
npm run ios:open
```

`ios:sync` stages the iOS release, syncs plugins, generates/checks assets,
applies the minimum OS target, wires entitlements and APNs callbacks, and
resolves CocoaPods. Yahoo remains available on the web; its controls, restore
paths and incoming provider links are disabled in the initial iOS release.

## 2. Distribution gates

The workflow passes the App Store Connect API key to both archive and export.
Xcode automatically manages archive signing and provisioning, then cloud-signs
the export with the managed Apple Distribution certificate and App Store
profile. CI imports no certificate or profile and never creates an ad-hoc
archive. Only the final distribution-signed IPA can pass the upload gate. The
API key must have the Admin role because App Manager access can upload builds
but cannot authorize cloud-managed distribution signing. The gate inspects the
exported icon and HTML, the app identifier,
production `aps-environment`, Associated Domains and provisioning-profile
compatibility. It rejects a temporary ad-hoc identity or missing capabilities.

The verified application identifier is `QTK6CZ6ZVU.app.fantasysportsnetwork`.
Both deployed AASA files must match it, and must exclude Privacy, Terms and
Support paths before the catch-all app route. Deploy both projects on merge.

APNs service credentials are separate from binary entitlements. Until production
APNs is configured, the app accurately disables alerts; configuring Web Push
alone must not enable the iOS control. No permission prompt occurs on cold boot.

## 3. Required device checks after rebuilding

- Install the newly processed TestFlight build; confirm the cyan FSN icon.
- Connect ESPN and Sleeper; open all six screens with a working review league.
- Confirm Yahoo is absent from iOS, including an old saved Yahoo selection and
  an incoming Yahoo link. Verify web Yahoo remains available separately.
- Open Setup → Privacy & Data → Support, Privacy and Terms. Tap Done and confirm
  the same app state and focused link return. Test phone and iPad.
- Erase with a registered test device: check removal, fresh onboarding and no
  automatic restoration. Test offline failure/retry before clearing data.
- Test a Universal Link on-device after both AASA deployments are live.
- If enabling APNs, verify delivery and opt-out using a dedicated test device.
- Verify the App Store Connect metadata against `ios/APP_STORE_METADATA.md`.
  That file is reviewable copy, not proof that fields were changed in Connect.

The automated browser return test uses a Capacitor bridge fixture. It does not
replace native Safari-sheet or Apple association verification on a real device.

---

## Manual Xcode preparation

Open `ios/App/App.xcworkspace`, select the App target and confirm:

- Bundle identifier: `app.fantasysportsnetwork`; team: `QTK6CZ6ZVU`.
- Automatic signing uses a distribution profile authorizing Push Notifications
  and Associated Domains. Enable both capabilities on this App ID in the Apple
  Developer portal if profile generation reports a mismatch.
- `CODE_SIGN_ENTITLEMENTS` points to the generated `App/App.entitlements`.
- The deployment target matches the repository's iOS 15 minimum. Use a physical
  device archive destination and an unused build number.
- Review the generated Info.plist and orientation behavior on iPhone and iPad.
  Ordinary HTTPS requests need no insecure App Transport Security exceptions.
  Visible push alerts do not require silent-push background execution.

Archive and export for App Store Connect. Before uploading a manual export, run
`python3 scripts/verify-ios-release.py /absolute/path/to/App.ipa` from the same
checkout and staged payload used to create the archive. CI runs this gate before
its upload step. The new export path must pass a real macOS run before sign-off.

Rebuild after merging these changes; do not submit the previously audited build
45. A successful build does not replace the device checks or App Review.
