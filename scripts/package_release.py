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
from zipfile import ZIP_DEFLATED, ZipFile

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


def launchers(platform, arch, staging, build, binary):
    if platform == 'macos':
        mac_arch = 'x86_64' if arch == 'x64' else arch
        subprocess.run(['zsh', str(ROOT / 'menubar/build.sh'), str(build)], env={**os.environ, 'MACOS_TARGET_ARCH': mac_arch}, check=True)
        shutil.copytree(build / 'Codex Plan Router.app', staging / 'Codex Plan Router.app')
        (staging / 'menubar').mkdir()
        shutil.copy2(ROOT / 'menubar/install.py', staging / 'menubar/install.py')
        shutil.copy2(ROOT / 'scripts/Install.command', staging / 'Install.command')
        return
    if platform == 'windows':
        (staging / 'router.cmd').write_bytes((
            '@echo off\r\n'
            'pushd "%~dp0"\r\n'
            'set "NODE_USE_ENV_PROXY=1"\r\n'
            'set "NO_PROXY=localhost,127.0.0.1,::1,%NO_PROXY%"\r\n'
            '"%~dp0runtime\\node.exe" "%~dp0cli.mjs" %*\r\n'
            'set "router_status=%ERRORLEVEL%"\r\n'
            'popd\r\nexit /b %router_status%\r\n'
        ).encode('ascii'))
        for name, command in [('Start.cmd', 'serve'), ('Settings.cmd', 'dashboard')]:
            (staging / name).write_bytes(f'@echo off\r\ncall "%~dp0router.cmd" {command}\r\nif errorlevel 1 pause\r\n'.encode('ascii'))
        return
    write_executable(staging / 'router', f'''#!/bin/sh
set -eu
root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export NODE_USE_ENV_PROXY=1
export NO_PROXY="localhost,127.0.0.1,::1,${{NO_PROXY:-}}"
exec "$root/runtime/{binary}" "$root/cli.mjs" "$@"
''')


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
    args.dist.mkdir(parents=True, exist_ok=True)
    stem = f'codex-plan-router-v{RELEASE_VERSION}-{args.platform}-{args.arch}'
    with TemporaryDirectory(prefix='codex-router-build-') as directory:
        base = Path(directory)
        staging = base / stem
        staging.mkdir()
        for name in FILES:
            shutil.copy2(ROOT / name, staging / name)
        binary = node_runtime(args.platform, args.arch, staging / 'runtime')
        launchers(args.platform, args.arch, staging, base / 'build', binary)
        if args.platform == 'linux':
            target = args.dist / (stem + '.tar.gz')
            with tarfile.open(target, 'w:gz') as archive:
                archive.add(staging, arcname=stem)
        else:
            target = args.dist / (stem + '.zip')
            with ZipFile(target, 'w', compression=ZIP_DEFLATED, compresslevel=6) as archive:
                for path in sorted(staging.rglob('*')):
                    archive.write(path, path.relative_to(base))
    print(target)


if __name__ == '__main__':
    main()
