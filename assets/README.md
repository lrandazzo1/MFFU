# FSN iOS source assets

`icon.svg` is the source of truth: an outlined FSN wordmark using the app's cyan
(`#00e0ff`) and ink (`#080a0e`). It uses no external fonts or image downloads.

`npm run assets:source` generates the committed opaque 1024 × 1024 `icon.png`
and center-safe 2732 × 2732 `splash.png`. iOS supplies the icon corner mask.

After generating the native project, run `npm run ios:assets`. This regenerates
the masters, writes the Xcode icon/launch catalogs, and verifies every generated
icon against the FSN master. The iOS workflow runs it after Capacitor sync.

Before TestFlight upload, `verify-ios-release.py` checks the actual exported
icons, native identity, signed entitlements and packaged HTML. An icon/config
failure stops upload. Review the icon in the next installed build as well.
