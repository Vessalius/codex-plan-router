#!/usr/bin/env python3
"""Install or mount a release artifact and check it with an offline backend."""
from argparse import ArgumentParser
from hashlib import sha256
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
from tempfile import TemporaryDirectory
import time
from urllib.request import ProxyHandler, build_opener


def smoke(bundle, root):
    node = bundle / 'runtime' / ('node.exe' if os.name == 'nt' else 'node')
    source = bundle / 'cli.mjs'
    arch = {'amd64': 'x64', 'x86_64': 'x64', 'arm64': 'arm64', 'aarch64': 'arm64'}[platform.machine().lower()]
    assert subprocess.check_output([node, '-p', 'process.arch'], text=True).strip() == arch
    assert not any((bundle / name).exists() for name in ('state.json', 'auth.json', 'test', 'backups'))
    snapshot = root / 'test-state'
    env = {**os.environ, 'CODEX_HOME': str(root / 'fake-codex'), 'NODE_USE_ENV_PROXY': '0'}
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    flags = ['--state', str(snapshot), '--port', str(port)]
    server = subprocess.Popen([node, source, 'serve', *flags, '--offline', '--parent-pipe'],
                              env=env, stdin=subprocess.PIPE)
    try:
        opener = build_opener(ProxyHandler({}))
        for _ in range(50):
            try:
                with opener.open(f'http://127.0.0.1:{port}/health', timeout=1) as response:
                    assert json.load(response).get('app') == 'Codex Plan Router'
                    break
            except OSError:
                if server.poll() is not None:
                    raise RuntimeError('Packaged router exited at startup')
                time.sleep(0.1)
        else:
            raise RuntimeError('Packaged router did not become ready')
        status = json.loads(subprocess.check_output([node, source, 'status', *flags], env=env, text=True,
                                                    encoding='utf-8'))
        assert status['desktop']['enabled'] is False
        assert not any(account['registered'] for account in status['accounts'])
        subprocess.run([node, source, 'stop', *flags], check=True, timeout=15, env=env)
        assert server.wait(timeout=10) == 0
        assert not (snapshot / 'daemon.lock').exists()
    finally:
        server.stdin.close()
        if server.poll() is None:
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument('installer', type=Path)
    artifact = parser.parse_args().installer.resolve()
    with TemporaryDirectory(prefix='codex-router-check-') as directory:
        root = Path(directory)
        if artifact.suffix == '.dmg':
            subprocess.run(['hdiutil', 'verify', artifact], check=True)
            mount = root / 'mount'
            mount.mkdir()
            subprocess.run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', mount, artifact], check=True)
            try:
                app = mount / 'Codex Plan Router.app'
                assert (mount / 'Applications').readlink() == Path('/Applications')
                assert (app / 'Contents/Resources/Router.icns').is_file()
                subprocess.run(['codesign', '--verify', '--strict', app], check=True)
                smoke(app / 'Contents/Resources/RouterBackend', root)
            finally:
                subprocess.run(['hdiutil', 'detach', mount], check=True)
        elif artifact.suffix == '.exe':
            target = root / 'installed'
            subprocess.run(f'"{artifact}" /S /D={target}', check=True, timeout=120)
            assert (target / 'Uninstall.exe').is_file()
            smoke(target, root)
        elif artifact.suffix == '.deb':
            dpkg_arch = subprocess.check_output(['dpkg', '--print-architecture'], text=True).strip()
            package_arch = subprocess.check_output(['dpkg-deb', '--field', artifact, 'Architecture'], text=True).strip()
            assert dpkg_arch == package_arch
            target = root / 'installed'
            subprocess.run(['dpkg-deb', '--extract', artifact, target], check=True)
            assert os.access(target / 'usr/bin/codex-plan-router', os.X_OK)
            assert (target / 'usr/share/applications/codex-plan-router.desktop').is_file()
            smoke(target / 'usr/lib/codex-plan-router', root)
        else:
            parser.error('expected .dmg, .exe or .deb')
    print(f'{sha256(artifact.read_bytes()).hexdigest()}  {artifact.name}')


if __name__ == '__main__':
    main()
