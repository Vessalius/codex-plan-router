#!/usr/bin/env python3
"""Verify and smoke-test an archive on a matching host."""
from argparse import ArgumentParser
from hashlib import sha256
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import signal
import socket
import subprocess
import tarfile
from tempfile import TemporaryDirectory
import time
from urllib.request import ProxyHandler, build_opener
from zipfile import ZipFile


def smoke(bundle, root):
    node = bundle / 'runtime' / ('node.exe' if os.name == 'nt' else 'node')
    source = bundle / 'cli.mjs'
    arch = {'amd64': 'x64', 'x86_64': 'x64', 'arm64': 'arm64', 'aarch64': 'arm64'}[platform.machine().lower()]
    assert subprocess.check_output([node, '-p', 'process.arch'], text=True).strip() == arch
    snapshot = root / 'test-state'
    env = {**os.environ, 'CODEX_HOME': str(root / 'fake-codex'), 'NODE_USE_ENV_PROXY': '0'}
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    flags = ['--state', str(snapshot), '--port', str(port)]
    server = subprocess.Popen([node, source, 'serve', *flags], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        opener = build_opener(ProxyHandler({}))
        for _ in range(40):
            try:
                with opener.open(f'http://127.0.0.1:{port}/health', timeout=1) as response:
                    if json.load(response).get('app') == 'Codex Plan Router':
                        break
            except OSError:
                if server.poll() is not None:
                    raise RuntimeError('Packaged router exited at startup')
            time.sleep(0.1)
        else:
            raise RuntimeError('Packaged router did not become ready')
        status = json.loads(subprocess.check_output([node, source, 'status', *flags], env=env, text=True))
        assert status['desktop']['enabled'] is False
        assert not any(account['registered'] for account in status['accounts'])
    finally:
        if server.poll() is None:
            server.terminate() if os.name == 'nt' else server.send_signal(signal.SIGTERM)
        server.communicate(timeout=15)


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--smoke', action='store_true')
    args = parser.parse_args()
    forbidden = {'state.json', 'auth.json', '.env', 'backups', 'test', 'reports', '.git'}
    is_zip = args.archive.suffix == '.zip'
    archive = ZipFile(args.archive) if is_zip else tarfile.open(args.archive)
    with TemporaryDirectory(prefix='codex-router-check-') as directory, archive:
        root = Path(directory)
        names = archive.namelist() if is_zip else archive.getnames()
        parts = [PurePosixPath(name).parts for name in names]
        assert parts and len({name[0] for name in parts}) == 1
        assert all(not forbidden.intersection(name) and all(not part.startswith('quota-cache') for part in name) for name in parts)
        prefix = parts[0][0]
        required = ['cli.mjs', 'platform.mjs', 'README.md', 'LICENSE', 'runtime/LICENSE']
        required.append('runtime/node.exe' if '-windows-' in prefix else 'runtime/node')
        assert all(f'{prefix}/{name}' in names for name in required)
        if args.smoke:
            if is_zip:
                # macOS 需要保留 ZIP 中的可执行权限和代码签名。
                if platform.system() == 'Darwin':
                    subprocess.run(['/usr/bin/ditto', '-x', '-k', args.archive, root], check=True)
                else:
                    archive.extractall(root)
            else:
                archive.extractall(root, filter='data')
            if platform.system() == 'Darwin':
                subprocess.run(['/usr/bin/codesign', '--verify', '--strict', root / prefix / 'Codex Plan Router.app'], check=True)
            smoke(root / prefix, root)
    print(f'{sha256(args.archive.read_bytes()).hexdigest()}  {args.archive.name}')


if __name__ == '__main__':
    main()
