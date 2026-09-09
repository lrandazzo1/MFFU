#!/usr/bin/env python3
"""Generate a deterministic ExportOptions.plist for Xcode-managed App Store export."""
import pathlib
import plistlib
import sys

if len(sys.argv) != 3:
    raise SystemExit(
        "usage: generate-ios-export-options.py OUTPUT_PATH APPLE_TEAM_ID"
    )

output = pathlib.Path(sys.argv[1])
team_id = sys.argv[2].strip()
if not team_id:
    raise SystemExit("APPLE_TEAM_ID must not be empty")

options = {
    "destination": "export",
    "manageAppVersionAndBuildNumber": False,
    "method": "app-store-connect",
    "signingCertificate": "Apple Distribution",
    "signingStyle": "automatic",
    "stripSwiftSymbols": True,
    "teamID": team_id,
}

output.parent.mkdir(parents=True, exist_ok=True)
with output.open("wb") as stream:
    plistlib.dump(options, stream, sort_keys=True)

with output.open("rb") as stream:
    written = plistlib.load(stream)
if written != options:
    raise SystemExit("ExportOptions.plist round-trip validation failed")

print(
    "[ios-export] automatic app-store-connect export configured "
    f"for team {team_id}"
)
