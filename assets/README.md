# FSN — iOS source assets

`@capacitor/assets` reads a single source logo + splash from this folder and
generates every icon / launch image size Xcode needs. Drop the two files
below in, then run `npm run ios:assets`.

| File | Size | Notes |
|---|---|---|
| `assets/icon.png` | 1024 × 1024 PNG, opaque | App icon master. No transparency, no rounded corners (iOS masks them). |
| `assets/icon-foreground.png` | 1024 × 1024 PNG, transparent | Optional. Foreground layer for adaptive icons. |
| `assets/icon-background.png` | 1024 × 1024 PNG, opaque | Optional. Background layer for adaptive icons. |
| `assets/splash.png` | 2732 × 2732 PNG | Launch screen master. Center-safe (edges get cropped on smaller devices). |
| `assets/splash-dark.png` | 2732 × 2732 PNG | Optional. Used when the device is in dark mode. |

After running the generator, Capacitor writes into:

- `ios/App/App/Assets.xcassets/AppIcon.appiconset/`
- `ios/App/App/Assets.xcassets/Splash.imageset/`

Both are picked up automatically by Xcode — no manual drag-and-drop.
