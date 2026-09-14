#!/usr/bin/env python3
"""Generate and validate an XML ExportOptions.plist for App Store export."""
import os
import pathlib
import plistlib
import shutil
import subprocess
import sys
import tempfile

EXPECTED_METHOD = "app-store-connect"
REQUIRED_KEYS = {
    "compileBitcode",
    "method",
    "signingStyle",
    "teamID",
}


def fail(message):
    raise SystemExit("[ios-export] " + message)


def validate_options(options, team_id):
    missing = REQUIRED_KEYS.difference(options)
    if missing:
        fail("missing required ExportOptions key(s): " + ", ".join(sorted(missing)))
    if options["method"] != EXPECTED_METHOD:
        fail("method must be " + EXPECTED_METHOD)
    if options["teamID"] != team_id:
        fail("teamID does not match APPLE_TEAM_ID")
    if options["signingStyle"] != "automatic":
        fail("signingStyle must be automatic for cloud-managed signing")
    if options["compileBitcode"] is not False:
        fail("compileBitcode must be false for this App Store export")


def validate_with_plutil(output):
    """Use Apple's parser when present, before xcodebuild sees the file."""
    plutil = shutil.which("plutil")
    if not plutil:
        return
    result = subprocess.run(
        [plutil, "-lint", str(output)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    if result.returncode:
        fail("plutil rejected " + str(output) + ": " + result.stdout.strip())


if len(sys.argv) != 3:
    fail("usage: generate-ios-export-options.py OUTPUT_PATH APPLE_TEAM_ID")

output = pathlib.Path(sys.argv[1])
team_id = sys.argv[2].strip()
if not team_id:
    fail("APPLE_TEAM_ID must not be empty")

options = {
    "compileBitcode": False,
    "destination": "export",
    "manageAppVersionAndBuildNumber": False,
    "method": EXPECTED_METHOD,
    "signingCertificate": "Apple Distribution",
    "signingStyle": "automatic",
    "stripSwiftSymbols": True,
    "teamID": team_id,
}
validate_options(options, team_id)

# plistlib's explicit XML format guarantees the document Xcode receives has a
# plist declaration, XML encoding, doctype, and root dictionary. Writing a
# complete temporary file and atomically replacing the target avoids an export
# process ever observing a partially-written plist.
payload = plistlib.dumps(options, fmt=plistlib.FMT_XML, sort_keys=True)
if not payload.startswith(b"<?xml") or b"<plist version=\"1.0\">" not in payload:
    fail("generated ExportOptions payload is not XML plist data")
try:
    decoded = plistlib.loads(payload)
except (plistlib.InvalidFileException, ValueError, TypeError) as error:
    fail("generated ExportOptions payload cannot be parsed: " + str(error))
validate_options(decoded, team_id)

output.parent.mkdir(parents=True, exist_ok=True)
temporary_path = None
try:
    with tempfile.NamedTemporaryFile(
        mode="wb",
        dir=output.parent,
        prefix=output.name + ".",
        suffix=".tmp",
        delete=False,
    ) as stream:
        temporary_path = pathlib.Path(stream.name)
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary_path, output)
    temporary_path = None
finally:
    if temporary_path and temporary_path.exists():
        temporary_path.unlink()

try:
    with output.open("rb") as stream:
        written = plistlib.load(stream)
except (plistlib.InvalidFileException, ValueError, TypeError) as error:
    fail("written ExportOptions.plist cannot be parsed: " + str(error))
validate_options(written, team_id)
validate_with_plutil(output)

print(
    "[ios-export] wrote validated XML app-store-connect ExportOptions.plist "
    f"for team {team_id}: {output}"
)
