#!/usr/bin/env python3
"""Fail before TestFlight upload if the exported IPA loses its identity/capabilities."""
import json
import os
import pathlib
import plistlib
import subprocess
import sys
import tempfile
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='fsn-release-') as scratch:
    with zipfile.ZipFile(sys.argv[1]) as ipa:
        ipa.extractall(scratch)
    apps = list((pathlib.Path(scratch) / 'Payload').glob('*.app'))
    if len(apps) != 1:
        raise SystemExit('Expected exactly one app in the exported IPA')
    app = apps[0]
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    details = subprocess.run(['codesign', '-dv', str(app)], capture_output=True, text=True, check=True).stderr
    if 'Signature=adhoc' in details or 'Authority=Apple Distribution:' not in details:
        raise SystemExit('Export must have an Apple Distribution signature, not an unsigned/ad-hoc identity')
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    signed = plistlib.loads(subprocess.check_output(['codesign', '-d', '--entitlements', ':-', str(app)], stderr=subprocess.DEVNULL))
    profile = plistlib.loads(subprocess.check_output(['security', 'cms', '-D', '-i', str(app / 'embedded.mobileprovision')]))
    allowed = profile['Entitlements']
    association = json.loads((root / '.well-known/apple-app-site-association').read_text())
    app_id = association['applinks']['details'][0]['appIDs'][0]
    if signed.get('application-identifier') != app_id or info['CFBundleIdentifier'] != 'app.fantasysportsnetwork':
        raise SystemExit('Exported app identity does not match the live association configuration')
    if signed.get('application-identifier') != allowed.get('application-identifier'):
        raise SystemExit('Provisioning profile and executable app identifiers disagree')
    team = os.environ.get('APPLE_TEAM_ID', '').strip()
    if team and signed.get('com.apple.developer.team-identifier') != team:
        raise SystemExit('Executable does not match the selected signing team')
    if signed.get('get-task-allow') is not False:
        raise SystemExit('Release executable must disable debugging')
    requested = plistlib.loads((root / 'ios/App.entitlements').read_bytes())
    domains_key = 'com.apple.developer.associated-domains'
    if sorted(signed.get(domains_key, [])) != sorted(requested[domains_key]):
        raise SystemExit('Export lost or changed Associated Domains')
    authorized_domains = allowed.get(domains_key, [])
    if '*' not in authorized_domains and not set(requested[domains_key]).issubset(authorized_domains):
        raise SystemExit('Distribution profile does not authorize Associated Domains')
    if signed.get('aps-environment') != 'production' or allowed.get('aps-environment') != 'production':
        raise SystemExit('Export/profile must both authorize production APNs')
    if (app / 'public/index.html').read_bytes() != (root / 'www/index.html').read_bytes():
        raise SystemExit('Export does not contain the checked iOS web payload')
    icons = list(app.glob('AppIcon*.png'))
    if not icons:
        raise SystemExit('No compiled app icon found to verify')
    for icon in icons:
        normal = pathlib.Path(scratch) / icon.name
        subprocess.run(['xcrun', 'pngcrush', '-q', '-revert-iphone-optimizations', str(icon), str(normal)], check=True)
        subprocess.run(['node', str(root / 'scripts/verify-compiled-icon.mjs'), str(normal)], check=True)
    print('[ios-release] Exported identity, distribution signature, capabilities, payload and branded icons verified.')
