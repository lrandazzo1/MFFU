#!/usr/bin/env python3
"""Fail before TestFlight upload if the exported IPA loses its identity/capabilities."""
import json
import os
import pathlib
import plistlib
import subprocess
import struct
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

    # Xcode 26 cloud signatures can omit Authority= lines from codesign -dv,
    # and codesign cannot extract their certificates. Read the standard Mach-O
    # LC_CODE_SIGNATURE superblob directly and inspect its CMS certificate chain.
    executable = app / info['CFBundleExecutable']
    macho = executable.read_bytes()
    if macho[:4] != b'\xcf\xfa\xed\xfe':
        raise SystemExit('Exported executable is not a thin 64-bit iOS Mach-O')
    command_count = struct.unpack_from('<I', macho, 16)[0]
    command_offset = 32
    signature = None
    for _ in range(command_count):
        if command_offset + 8 > len(macho):
            raise SystemExit('Mach-O load commands are truncated')
        command, command_size = struct.unpack_from('<II', macho, command_offset)
        if command_size < 8 or command_offset + command_size > len(macho):
            raise SystemExit('Mach-O load command has an invalid size')
        if command == 0x1D:  # LC_CODE_SIGNATURE
            data_offset, data_size = struct.unpack_from('<II', macho, command_offset + 8)
            signature = macho[data_offset:data_offset + data_size]
            if len(signature) != data_size:
                raise SystemExit('Mach-O code signature is truncated')
            break
        command_offset += command_size
    if signature is None:
        raise SystemExit('Exported executable has no LC_CODE_SIGNATURE')

    magic, signature_length, slot_count = struct.unpack_from('>III', signature, 0)
    if magic != 0xFADE0CC0 or signature_length > len(signature):
        raise SystemExit('Executable code signature superblob is invalid')
    cms = None
    for index in range(slot_count):
        slot_type, slot_offset = struct.unpack_from('>II', signature, 12 + index * 8)
        if slot_type != 0x10000:  # CSSLOT_SIGNATURESLOT
            continue
        slot_magic, slot_length = struct.unpack_from('>II', signature, slot_offset)
        if slot_magic != 0xFADE0B01 or slot_offset + slot_length > signature_length:
            raise SystemExit('Executable CMS signature slot is invalid')
        cms = signature[slot_offset + 8:slot_offset + slot_length]
        break
    if not cms:
        raise SystemExit('Exported executable has no CMS signing certificate')

    certificates = subprocess.run(
        ['/usr/bin/openssl', 'pkcs7', '-inform', 'DER', '-print_certs', '-noout'],
        input=cms,
        capture_output=True,
        check=True,
    ).stdout.decode('utf-8', errors='replace')
    if 'Apple Distribution:' not in certificates:
        raise SystemExit('Export leaf certificate is not Apple Distribution')
    if 'Apple Worldwide Developer Relations Certification Authority' not in certificates:
        raise SystemExit('Export signing certificate has no Apple developer intermediate')
    if 'Apple Root CA' not in certificates:
        raise SystemExit('Export signing certificate has no Apple root certificate')
    if not authorities:
        print(
            '[ios-release] codesign omitted Authority metadata; '
            'verified the Apple Distribution CMS certificate chain directly.',
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
