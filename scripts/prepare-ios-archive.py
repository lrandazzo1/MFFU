#!/usr/bin/env python3
"""Embed requested capabilities before Xcode re-signs the unsigned archive for distribution.

An unsigned archive has no signature from which export can recover entitlements.
The temporary ad-hoc signatures are only an export input. They must never be
uploaded: verify-ios-release.py requires a final Apple distribution signature.
"""
import pathlib
import plistlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parent.parent
archive = pathlib.Path(sys.argv[1])
apps = list((archive / 'Products/Applications').glob('*.app'))
if len(apps) != 1:
    raise SystemExit('Expected exactly one app in the archive')
app = apps[0]
entitlements = root / 'ios/App/App/App.entitlements'
with entitlements.open('rb') as f:
    requested = plistlib.load(f)
if not requested.get('com.apple.developer.associated-domains') or requested.get('aps-environment') != 'production':
    raise SystemExit('Release capabilities are missing from the generated entitlement file')
# Sign inside out; never use --deep to copy app entitlements onto frameworks.
frameworks = sorted(app.glob('Frameworks/**/*.framework'), key=lambda p: len(p.parts), reverse=True)
for framework in frameworks:
    subprocess.run(['codesign', '--force', '--sign', '-', str(framework)], check=True)
subprocess.run(['codesign', '--force', '--sign', '-', '--generate-entitlement-der',
                '--entitlements', str(entitlements), str(app)], check=True)
signed = subprocess.check_output(['codesign', '-d', '--entitlements', ':-', str(app)], stderr=subprocess.DEVNULL)
if plistlib.loads(signed) != requested:
    raise SystemExit('Archive signature did not preserve the requested capabilities')
print('[ios-archive] Requested capabilities are embedded; distribution export is still required.')
