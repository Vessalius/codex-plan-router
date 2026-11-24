#!/usr/bin/env python3
import os
import pathlib
import plistlib
import shutil
import subprocess
import sys
import time
import re


def main():
    source = pathlib.Path(__file__).resolve().parent
    built = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/private/tmp/codex-plan-router-menubar-build/Codex Plan Router.app')
    with (built / 'Contents/Info.plist').open('rb') as f:
        metadata = plistlib.load(f)
    bundle_id = 'com.sun.codex-plan-router.menubar'
    if metadata.get('CFBundleIdentifier') != bundle_id or not metadata.get('LSUIElement'):
        raise RuntimeError('待安装应用的身份或菜单栏配置不匹配')
    subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(built)], check=True)
    destination = pathlib.Path.home() / 'Applications/Codex Plan Router.app'
    label = bundle_id
    domain = f'gui/{os.getuid()}'
    if destination.exists():
        with (destination / 'Contents/Info.plist').open('rb') as f:
            existing = plistlib.load(f)
        if existing.get('CFBundleIdentifier') != bundle_id:
            raise RuntimeError('目标位置已有其他应用，未覆盖')
        current = subprocess.run(['/bin/launchctl', 'print', f'{domain}/{label}'], capture_output=True, text=True)
        match = re.search(r'^\s*pid = (\d+)\s*$', current.stdout, flags=re.MULTILINE)
        old_pid = int(match.group(1)) if match else None
        subprocess.run(['/bin/launchctl', 'bootout', f'{domain}/{label}'], capture_output=True)
        if old_pid:
            for _ in range(30):
                try:
                    os.kill(old_pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError('旧菜单栏进程仍在退出，未覆盖应用；请稍后重试')
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(built, destination, dirs_exist_ok=True)
    installed_source = pathlib.Path.home() / '.local/share/codex-plan-router/menubar'
    if source != installed_source:
        shutil.copytree(source, installed_source, dirs_exist_ok=True)
    for name in ['quota.mjs', 'quota-native.mjs']:
        quota_source = source.parent / name
        if quota_source.exists() and quota_source != installed_source.parent / name:
            shutil.copyfile(quota_source, installed_source.parent / name)
    with (pathlib.Path.home() / 'Library/LaunchAgents/com.sun.codex-plan-router.plist').open('rb') as f:
        backend = plistlib.load(f)
    node = backend['ProgramArguments'][0]
    quote = lambda value: "'" + str(value).replace("'", "'\\''") + "'"
    # 网络出口只复用已经安装、验证过的无凭据本机代理。
    proxy_env = backend.get('EnvironmentVariables', {})
    from urllib.parse import urlsplit
    environment = 'export NODE_USE_ENV_PROXY=1\n'
    for key in ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']:
        value = proxy_env.get(key)
        if not value:
            continue
        url = urlsplit(value)
        if url.scheme not in ['http', 'https'] or url.hostname not in ['localhost', '127.0.0.1', '::1'] or url.username or url.password or url.query or url.fragment or url.path not in ['', '/']:
            raise RuntimeError('现有服务的网络代理配置不符合无凭据回环地址要求')
        environment += f'export {key}={quote(value)}\n'
    for slot in ['a', 'b']:
        launcher = installed_source.parent / f'授权账号{slot.upper()}额度.command'
        launcher.write_text('#!/bin/zsh\n' + environment + f'{quote(node)} {quote(installed_source.parent / "quota-native.mjs")} login {slot}\n' + 'printf "\\n按回车关闭此窗口。"\nread -r\n')
        launcher.chmod(0o700)
    settings_launcher = installed_source.parent / '打开设置.command'
    settings_launcher.write_text('#!/bin/zsh\n/usr/bin/open ' + quote(destination) + ' --args --settings\n')
    settings_launcher.chmod(0o700)
    agents = pathlib.Path.home() / 'Library/LaunchAgents'
    agents.mkdir(parents=True, exist_ok=True)
    plist_path = agents / f'{label}.plist'
    # 只启动菜单栏界面，不触碰现有后台服务；退出图标后不会立即拉起。
    payload = {
        'Label': label,
        'ProgramArguments': [str(destination / 'Contents/MacOS/RouterMenu')],
        'RunAtLoad': True,
        'KeepAlive': False,
        'ProcessType': 'Interactive',
        'LimitLoadToSessionType': 'Aqua',
    }
    temp = plist_path.with_suffix('.plist.tmp')
    with temp.open('wb') as f:
        plistlib.dump(payload, f)
    temp.chmod(0o600)
    temp.replace(plist_path)
    subprocess.run(['/usr/bin/plutil', '-lint', str(plist_path)], check=True)
    subprocess.run(['/bin/launchctl', 'bootstrap', domain, str(plist_path)], check=True)
    print(f'菜单栏工具已安装：{destination}')
    print('已启用登录自启动；现有后台代理、账号授权和 Codex 会话保持运行。')


if __name__ == '__main__':
    main()
