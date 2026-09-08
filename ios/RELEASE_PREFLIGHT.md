# Release polish verification — 8 September 2026

Branch: `codex/app-store-release-polish`
Base: `5af33933f5f7e5961a5d3f415f783cae6dfcd440`

## Implemented

- Reproducible opaque FSN icon and launch assets, generated-catalog checks and
  an exported-IPA branding check before upload.
- iOS-only Yahoo UI removal, restored-selection filtering and incoming-link
  guards. Web Yahoo remains available.
- FSN local/session prefixes, the legacy walkthrough flag and memory storage
  are cleared together. Disconnect failure keeps data and receipts for retry;
  successful erasure reloads without league/invite parameters.
- Per-platform push availability, bounded network waits, registration/disable
  coordination and a visible retry for incomplete opt-out, including relaunch.
- APNs callbacks, requested production entitlements, verified AASA app identity
  and Support/legal exclusions. Final distribution signature checks block an
  upload that loses these capabilities.
- Native Support link, browser-finished focus restoration and visible failures.
- Current empty-state/landing copy and privacy disclosures for actual retention.
- Proposed App Store fields and a rebuild/device handoff checklist.

## Verification completed locally

| Check | Result |
| --- | --- |
| Cross-script scope scan | Pass; all eight inline blocks resolve |
| Cleanup and push failure/race fixtures | Pass |
| Notification trigger suite | 133 assertions passed |
| Notification dispatcher audit | 73 assertions passed |
| Landing analytics claims | Pass |
| iOS payload staging/provider stripping | Pass |
| FSN source and generated icon catalog | Pass |
| Compiled-icon comparator against source PNG | Pass; actual IPA still required |
| Native capability wiring, repeated for idempotence | Pass |
| Both AASA/configuration checks | Pass |
| Python/JavaScript parse checks and diff whitespace | Pass |
| Protected code comparison | Unchanged as described below |

Protected API, database, notification rules and editorial schedule files have no
diff. Cloud/intel/narrative/analytics script blocks, the historical/provider data
pipeline and landing-page scripts are byte-identical to the base commit.

## Outstanding gates

`CLAUDE.md` requires a seeded headless six-screen render before committing.
The approved browser connection cannot load this workspace, and the
control-browser skill restricts switching to standalone browser automation.
The prepared Release Checks workflow installs its test browser and runs the
existing complete verification suite plus the new release and support-return
fixtures. The user explicitly approved moving the required pre-commit browser gate into
PR CI on 8 September 2026. Browser verification is pending that run; no browser
pass is claimed here.

After that gate, the next macOS build must validate the new archive/export path
and inspect the actual distribution-signed IPA. The temporary archive signature
is an intermediate export input; the upload gate rejects it if it survives.
Native Support return, APNs delivery/opt-out and Universal Links still require
real-device checks. No new IPA or TestFlight upload was produced in this session.

Publish the policy and AASA changes after merge, then recheck the live URLs.
App Store Connect fields have not been changed. Supply and test an authorized
review league ID before submission. The prior build 45 remains unsuitable for
submission; this branch is not an App Review approval guarantee.
