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
    if 'Signature=adhoc' in details:
        raise SystemExit('Export is unsigned or uses an ad-hoc signature')
    authorities = [
        line.split('=', 1)[1].strip()
        for line in details.splitlines()
        if line.startswith('Authority=')
    ]
    if authorities and not any(authority.startswith('Apple Distribution:') for authority in authorities):
        raise SystemExit('Export must use an Apple Distribution signing identity')

    # Xcode 26 cloud signatures can omit Authority= lines from codesign -dv.
    # Extract the CMS leaf certificate instead of treating display formatting
    # as signing identity. An ad-hoc signature has no certificate to extract.
    certificate_prefix = pathlib.Path(scratch) / 'signer-cert-'
    subprocess.run(
        ['codesign', '-d', '--extract-certificates', str(certificate_prefix), str(app)],
        capture_output=True,
        text=True,
        check=True,
    )
    certificates = sorted(pathlib.Path(scratch).glob('signer-cert-*'))
    if not certificates:
        raise SystemExit('Export has no signing certificate to verify')
    leaf_subject = subprocess.check_output(
        [
            '/usr/bin/openssl', 'x509', '-inform', 'DER',
            '-in', str(certificates[0]), '-noout', '-subject',
        ],
        text=True,
    )
    if 'Apple Distribution:' not in leaf_subject:
        raise SystemExit('Export leaf certificate is not Apple Distribution')
    if not authorities:
        print(
            '[ios-release] codesign omitted Authority metadata; '
            'verified Apple Distribution from the extracted CMS leaf certificate.',
            file=sys.stderr,
        )

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
    print('[ios-release] Exported identity, signature integrity, capabilities, payload and branded icons verified.')
