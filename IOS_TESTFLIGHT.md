# iOS / TestFlight — Fantasy Sports Network

Native iOS packaging for the existing web app, using [Capacitor](https://capacitorjs.com)
plus a manual GitHub Actions workflow that signs the build and uploads it to TestFlight.

**Nothing about the web app or the Vercel setup changed.** `index.html`,
`league-media-studio.html`, `api/*`, `landing/*` and `supabase/*` are byte-for-byte
the same, and no `vercel.json` was added or edited. The pipeline only *reads* the
production HTML.

---

## 1. What was added

| Path | Purpose |
| ---- | ------- |
| `capacitor.config.json` | App identity: `Fantasy Sports Network` / `com.fantasysportsnetwork.app`, `webDir: "www"`. |
| `scripts/build-ios-web.mjs` | Stages the production HTML into `www/` (Capacitor's web root). Read-only against the sources. |
| `ios/` | Generated native Xcode project (`npx cap add ios`). Uses Swift Package Manager — no CocoaPods. |
| `ios/App/fastlane/Fastfile` | `beta` lane (build + upload) and `build_only` lane (signing dry run). |
| `.github/workflows/ios-testflight.yml` | `workflow_dispatch` pipeline on `macos-latest`. |
| `.vercelignore` | Keeps `ios/`, `www/`, `scripts/`, `.github/` out of both Vercel deployments. |

Three npm scripts were added — deliberately **not** named `build`, because Vercel
auto-runs a `build` script when one exists and the app project has no build step:

```bash
npm run build:ios   # stage www/ from the production HTML
npm run sync:ios    # build:ios + npx cap sync ios
npm run open:ios    # open the project in Xcode (macOS only)
```

Capacitor is in `devDependencies`, so it is never imported by the app or the
serverless functions.

### Two things worth knowing

**A `package-lock.json` now exists.** There wasn't one before, so Vercel resolved
`@supabase/supabase-js` fresh on every build; it is now pinned at the version that
resolves today (`2.112.4`). This makes both CI and Vercel builds reproducible. If you
would rather Vercel keep floating, delete the lockfile and change `npm ci` to
`npm install` in the workflow.

**`/api/*` calls are rewritten inside the native shell.** The app fetches
`/api/espn`, `/api/league` and `/api/sleeper` as root-relative paths. In the WebView
the bundle is served from `capacitor://localhost`, where those would 404, so
`scripts/build-ios-web.mjs` injects a small shim into the **`www/` copies only** that
points them at `https://app.fantasysportsnetwork.app`. On any `http(s)` origin —
Vercel, a local preview — the shim is a no-op. Override the target with
`FSN_API_ORIGIN` if the API ever moves.

**`npm install` logs an `EBADENGINE` warning.** The root `engines.node` stays at
`>=18` (changing it would change the Node runtime Vercel picks for the serverless
functions), while the Capacitor CLI asks for `>=22`. npm only warns and continues, and
the workflow runs on Node 22 where the requirement is met. Don't add
`engine-strict=true` to an `.npmrc` — that would turn the warning into a failed Vercel
build.

> The API routes already return CORS headers for the FSN origins (see
> `api/waitlist.js` and `DEPLOYMENT.md` §4). Requests from the app arrive with
> `Origin: capacitor://localhost`, which is **not** in that allow-list — so if you
> later have the app POST to `/api/waitlist`, add that origin there. The read
> endpoints the app uses today (`espn`, `league`, `sleeper`) are unaffected.

---

## 2. Repository secrets checklist

Add each of these under **Settings → Secrets and variables → Actions → New repository secret**.
The workflow fails fast with a named list if any are missing.

### App Store Connect API key — for the TestFlight upload

- [ ] **`APP_STORE_CONNECT_API_ISSUER_ID`**
      App Store Connect → **Users and Access → Integrations → App Store Connect API**.
      The *Issuer ID* shown above the key table (a UUID).

- [ ] **`APP_STORE_CONNECT_API_KEY_ID`**
      The *Key ID* column for the key you generate (10 characters). Create the key with
      the **App Manager** role so it is allowed to upload builds.

- [ ] **`APP_STORE_CONNECT_API_KEY_BASE64`**
      The `AuthKey_<KEYID>.p8` file, base64-encoded. Apple lets you download it **once**.
      ```bash
      base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy
      ```

### Code signing — for the build itself

- [ ] **`APPLE_TEAM_ID`**
      Your 10-character Team ID, from
      [developer.apple.com/account](https://developer.apple.com/account) → Membership details.

- [ ] **`BUILD_CERTIFICATE_BASE64`**
      An **Apple Distribution** certificate exported from Keychain Access as a `.p12`
      (right-click the certificate → *Export*; make sure the private key is included),
      then base64-encoded.
      ```bash
      base64 -i distribution.p12 | pbcopy
      ```

- [ ] **`P12_PASSWORD`**
      The password you set when exporting that `.p12`. Do not leave it empty —
      `security import` needs a real password.

- [ ] **`BUILD_PROVISION_PROFILE_BASE64`**
      An **App Store** provisioning profile for `com.fantasysportsnetwork.app`, created at
      Certificates, Identifiers & Profiles → **Profiles → + → App Store Connect**, paired
      with the certificate above. Base64-encode the downloaded `.mobileprovision`.
      ```bash
      base64 -i FantasySportsNetwork_AppStore.mobileprovision | pbcopy
      ```
      The workflow reads the profile's *name* and *UUID* out of the file itself, so there
      is no separate secret for those — and it aborts if the profile's bundle ID doesn't
      match the app.

### Optional

- [ ] **`APPLE_ITC_TEAM_ID`** — only if your Apple ID belongs to more than one App Store
      Connect team and fastlane asks you to disambiguate.

> On Linux, use `base64 -w0 <file>` instead of `base64 -i <file>`.

---

## 3. One-time Apple setup

Before the first run, all of this has to exist on Apple's side:

- [ ] Paid **Apple Developer Program** membership (TestFlight is not available on a free account).
- [ ] An **App ID / Identifier** registered for `com.fantasysportsnetwork.app`.
- [ ] An **app record** in App Store Connect using that bundle ID, with the name
      *Fantasy Sports Network*. The upload fails if no app record exists.
- [ ] Export compliance answered — either in the app record, or by adding
      `ITSAppUsesNonExemptEncryption = false` to `ios/App/App/Info.plist` so each build
      doesn't stall waiting for an answer.
- [ ] At least one **internal tester group** in TestFlight to receive the build.
- [ ] **Replace the placeholder app icon.** `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`
      is Capacitor's generic 1024×1024 icon. It's valid (RGB, no alpha, so App Store
      Connect accepts it) but it is not your brand — drop in the real artwork at the same
      size and filename. Same for `Splash.imageset/` if you want a branded launch screen.

---

## 4. Running it

**Actions → iOS TestFlight → Run workflow.** All inputs are optional:

| Input | Default | Notes |
| ----- | ------- | ----- |
| `build_number` | auto | Empty = latest TestFlight build number + 1. Each upload needs a unique one. |
| `marketing_version` | project value | e.g. `1.0.3`. Sets `CFBundleShortVersionString`. |
| `changelog` | auto | "What to Test" notes. Only applied when `wait_for_processing` is on. |
| `wait_for_processing` | `false` | Waits 5–15 min for Apple to finish processing. |
| `upload` | `true` | Uncheck for a build-and-sign dry run — the fastest way to validate signing secrets. |

The workflow never runs on `push`, so it cannot interfere with a Vercel deploy. The
signed `.ipa` and dSYMs are attached to the run as artifacts either way, and the
temporary keychain is deleted on exit even when the build fails.

### Recommended first run

Run once with **`upload` unchecked**. That exercises checkout → `npm ci` →
`cap sync` → certificate import → archive → export without touching App Store
Connect, so a signing mistake costs three minutes instead of a rejected upload.

---

## 5. Working on it locally (macOS)

```bash
npm install
npm run sync:ios
npm run open:ios      # opens ios/App/App.xcodeproj in Xcode
```

The committed project uses **automatic** signing, which is what you want in Xcode.
Fastlane flips it to manual signing at build time on CI only, so your local setup and
the pipeline don't fight over the pbxproj.

Regenerating: `ios/App/App/public/`, `ios/App/App/capacitor.config.json` and
`ios/App/App/config.xml` are generated by `cap sync` and are gitignored — the workflow
recreates them on every run.

---

## 6. Troubleshooting

| Symptom | Cause |
| ------- | ----- |
| `No signing certificate "iOS Distribution" found` | `BUILD_CERTIFICATE_BASE64` is a *Development* certificate, or the `.p12` was exported without its private key. |
| `Provisioning profile ... doesn't include signing certificate` | The profile and the certificate aren't paired. Regenerate the profile after selecting that exact certificate. |
| `The bundle version must be higher than the previously uploaded version` | Build number reused. Leave `build_number` empty to auto-increment. |
| `Could not find app with bundle identifier` | No app record in App Store Connect yet (§3). |
| `Authentication credentials are missing or invalid` | The `.p8` was base64-encoded with line wraps. Use `base64 -w0` on Linux, or `base64 -i` on macOS. |
| Profile bundle-ID mismatch error | Expected — the workflow checks the profile against `com.fantasysportsnetwork.app` before building. |
