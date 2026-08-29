# FSN landing — app screenshots

The landing page (`landing/index.html`, "See the broadcast desk in action"
section) frames real app screens in phone mockups. Drop the screenshot files
here using the exact filenames below and they appear automatically.

| File | Screen it shows |
|------|-----------------|
| `news-desk.png`         | News tab — the News Desk / live wire with the "State of the League" lead feature and the running timeline |
| `matchups.png`          | Matchups tab — the projected head-to-head board with per-game margins |
| `season-stats.png`      | Season Stats tab — the Adjusted Expected Wins model with luck differential |
| `record-book.png`       | Record Book — a Franchise Dossier with Lifetime Vital Stats (all-time record, career PPG, playoff rate) |
| `franchise-dossier.png` | Record Book — the Franchise Résumé view with win %, titles and the year-by-year finish trend |

## Notes

- **Filenames must match exactly** (all lowercase, `.png`). If you'd rather use
  `.webp` or `.jpg`, update the `src` attributes in the showcase section of
  `landing/index.html` to match.
- The frames use a **9:19.5 phone aspect ratio** (`aspect-ratio:1080/2340`) and
  crop from the top (`object-position:top center`). Portrait phone
  screenshots (e.g. 1080×2340 or 1170×2532) fit cleanly; the status bar at the
  very top is fine to leave in.
- Until a file is present, its frame shows a labeled placeholder instead of a
  broken image (each `<img>` has an `onerror` fallback), so the page always
  looks intentional — deploy is never blocked on missing art.
- Keep files reasonably small (aim for < ~300 KB each; export at ~2× phone
  width). These load lazily (`loading="lazy"`).
