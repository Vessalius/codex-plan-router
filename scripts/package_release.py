#!/usr/bin/env python3
"""Package the reviewed sources and an official, verified Node.js runtime."""
from argparse import ArgumentParser
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
from tempfile import TemporaryDirectory
from urllib.request import urlopen
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
NODE_VERSION = (ROOT / '.node-version').read_text().strip()
RELEASE_VERSION = json.loads((ROOT / 'package.json').read_text())['version']
FILES = (
    'core.mjs', 'server.mjs', 'allocation.mjs', 'config.mjs', 'cli.mjs',
    'platform.mjs', 'ui.mjs', 'quota.mjs', 'quota-native.mjs',
    'package.json', 'README.md', 'LICENSE',
)


def download(url):
    with urlopen(url, timeout=90) as response:
        return response.read()


def node_runtime(platform, arch, output):
    target_os = {'macos': 'darwin', 'windows': 'win', 'linux': 'linux'}[platform]
    root = f'node-v{NODE_VERSION}-{target_os}-{arch}'
    windows = platform == 'windows'
    filename = root + ('.zip' if windows else '.tar.xz')
    base = f'https://nodejs.org/dist/v{NODE_VERSION}/'
    sums = dict((name, digest) for digest, name in (line.split() for line in download(base + 'SHASUMS256.txt').decode().splitlines()))
    archive = download(base + filename)
    if sums.get(filename) != sha256(archive).hexdigest():
        raise RuntimeError(f'Node.js archive checksum mismatch: {filename}')
    output.mkdir()
    binary = 'node.exe' if windows else 'node'
    if windows:
        with ZipFile(BytesIO(archive)) as reader:
            (output / binary).write_bytes(reader.read(f'{root}/node.exe'))
            (output / 'LICENSE').write_bytes(reader.read(f'{root}/LICENSE'))
    else:
        with tarfile.open(fileobj=BytesIO(archive), mode='r:xz') as reader:
            for member, target in [('bin/node', binary), ('LICENSE', 'LICENSE')]:
                with reader.extractfile(f'{root}/{member}') as entry, (output / target).open('wb') as file:
                    shutil.copyfileobj(entry, file)
        (output / binary).chmod(0o755)
    return binary


def write_executable(path, content):
    path.write_text(content, encoding='utf-8')
    path.chmod(0o755)


def build_dmg(payload, directory, target, arch):
    build = directory / 'build'
    mac_arch = 'x86_64' if arch == 'x64' else arch
    subprocess.run(
        ['zsh', str(ROOT / 'menubar/build.sh'), str(build)],
        env={**os.environ, 'MACOS_TARGET_ARCH': mac_arch},
        check=True,
    )
    app = build / 'Codex Plan Router.app'
    shutil.copytree(payload, app / 'Contents/Resources/RouterBackend')
    subprocess.run(['codesign', '--force', '--sign', '-', app], check=True)
    subprocess.run(['codesign', '--verify', '--strict', app], check=True)
    image = directory / 'image'
    image.mkdir()
    shutil.move(app, image)
    (image / 'Applications').symlink_to('/Applications', target_is_directory=True)
    subprocess.run(['hdiutil', 'create', '-ov', '-volname', 'Codex Plan Router',
                    '-srcfolder', image, '-format', 'UDZO', target], check=True)


def build_exe(payload, target, arch):
    compiler = shutil.which('makensis')
    if compiler is None:
        for key in ('ProgramFiles(x86)', 'ProgramFiles'):
            if os.environ.get(key):
                candidate = Path(os.environ[key]) / 'NSIS/makensis.exe'
                if candidate.is_file():
                    compiler = str(candidate)
                    break
    if compiler is None:
        raise RuntimeError('NSIS makensis is required')
    prefix = '/' if os.name == 'nt' else '-'
    definitions = {'OUTPUT': target, 'PAYLOAD': payload, 'VERSION': RELEASE_VERSION, 'ARCH': arch}
    subprocess.run([compiler, *(f'{prefix}D{key}={value}' for key, value in definitions.items()),
                    ROOT / 'installers/windows.nsi'], check=True)


def build_deb(payload, directory, target, arch):
    debian_arch = 'amd64' if arch == 'x64' else 'arm64'
    package = directory / 'deb'
    metadata = package / 'DEBIAN'
    metadata.mkdir(parents=True)
    (metadata / 'control').write_text(
        f'Package: codex-plan-router\nVersion: {RELEASE_VERSION}\nArchitecture: {debian_arch}\n'
        'Section: utils\nPriority: optional\nMaintainer: Codex Plan Router contributors\n'
        'Depends: libc6 (>= 2.28), libstdc++6, xdg-utils\n'
        'Recommends: python3 (>= 3.11)\n'
        'Description: Local Codex accounts and quota manager\n',
        encoding='ascii',
    )
    bundle = package / 'usr/lib/codex-plan-router'
    bundle.parent.mkdir(parents=True)
    shutil.move(payload, bundle)
    launcher = package / 'usr/bin/codex-plan-router'
    launcher.parent.mkdir(parents=True)
    write_executable(launcher, '''#!/bin/sh
set -eu
exec /usr/lib/codex-plan-router/runtime/node /usr/lib/codex-plan-router/cli.mjs "$@"
''')
    desktop = package / 'usr/share/applications/codex-plan-router.desktop'
    desktop.parent.mkdir(parents=True)
    desktop.write_text('''[Desktop Entry]
Type=Application
Name=Codex Plan Router
Exec=codex-plan-router launch
Icon=preferences-system-network
Terminal=false
Categories=Utility;
Actions=Stop;

[Desktop Action Stop]
Name=Stop Codex Plan Router
Exec=codex-plan-router stop
''', encoding='ascii')
    subprocess.run(['dpkg-deb', '--root-owner-group', '--build', package, target], check=True)


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument('platform', choices=['macos', 'windows', 'linux'])
    parser.add_argument('arch', choices=['x64', 'arm64'])
    parser.add_argument('--dist', default=ROOT / 'dist', type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', RELEASE_VERSION):
        parser.error('package.json must use a numeric release version')
    if args.platform == 'macos' and sys.platform != 'darwin':
        parser.error('building the macOS app requires Xcode on macOS')
    dist = args.dist.resolve()
    dist.mkdir(parents=True, exist_ok=True)
    stem = f'codex-plan-router-v{RELEASE_VERSION}-{args.platform}-{args.arch}'
    with TemporaryDirectory(prefix='codex-router-build-') as directory:
        base = Path(directory)
        staging = base / 'payload'
        staging.mkdir()
        for name in FILES:
            shutil.copy2(ROOT / name, staging / name)
        node_runtime(args.platform, args.arch, staging / 'runtime')
        if args.platform == 'macos':
            target = dist / (stem + '.dmg')
            build_dmg(staging, base, target, args.arch)
        elif args.platform == 'windows':
            target = dist / (stem + '-setup.exe')
            build_exe(staging, target, args.arch)
        else:
            target = dist / (stem + '.deb')
            build_deb(staging, base, target, args.arch)
    print(target)


if __name__ == '__main__':
    main()
