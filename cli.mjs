#!/usr/bin/env node
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { openBrowser, stateDirectory } from './platform.mjs';
import { bilingual, cliLanguage, localizeMessage } from './i18n.mjs';
import { Store, APP, RouterError } from './core.mjs';
import { RouterServer } from './server.mjs';
import { DesktopConfig, installService } from './config.mjs';

const args = process.argv.slice(2), command = args[0] ?? 'help';
const language = cliLanguage();
const arg = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const stateDir = resolve(arg('--state', stateDirectory()));
const port = Number(arg('--port', '47631'));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(localizeMessage('端口必须在 1024 到 65535 之间', language));
const source = dirname(fileURLToPath(import.meta.url));

async function acquireLock() {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lock = join(stateDir, 'daemon.lock');
  for (let i = 0; i < 2; i++) {
    try { await writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); return () => unlink(lock).catch(() => {}); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let existing;
      try { existing = JSON.parse(await readFile(lock, 'utf8')); } catch { throw new RouterError('后台锁文件需要检查，未启动第二个进程'); }
      if (!Number.isSafeInteger(existing.pid) || existing.pid < 1) throw new RouterError('后台锁文件无效');
      try { process.kill(existing.pid, 0); throw new RouterError('后台服务已在运行'); }
      catch (error) { if (error.code === 'ESRCH') await unlink(lock); else throw error; }
    }
  }
  throw new RouterError('无法取得后台进程锁');
}
async function runningStore() {
  // 管理命令只读取状态，写入和令牌刷新统一交给单个后台进程。
  const data = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8'));
  return { dir: stateDir, data };
}
async function admin(path, body) {
  const store = await runningStore();
  const r = await fetch(`http://127.0.0.1:${port}/admin/${path}`, { signal: AbortSignal.timeout(180_000), method: body ? 'POST' : 'GET', headers: { 'x-router-key': store.data.adminKey, 'Accept-Language': language, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json();
  if (!r.ok) throw new RouterError(data.error?.message ?? '本地管理请求失败');
  return data;
}
async function listening() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).app === APP;
  } catch {
    return false;
  }
}

async function openDashboard() {
  const store = await runningStore();
  await admin('status');
  await openBrowser(`http://127.0.0.1:${port}/#${store.data.adminKey}`);
}

async function main() {
  if (command === 'serve') {
    const release = await acquireLock();
    try {
      const store = await new Store(stateDir).init();
      const offline = args.includes('--offline');
      const fetcher = offline ? async () => { throw new RouterError('此实例为离线验证模式', 503); } : undefined;
      const server = await new RouterServer(store, { port, fetcher }).listen();
      if (!offline) server.startQuotaMonitor();
      console.log(bilingual(language, `${APP} 已启动，监听 127.0.0.1:${port}。`, `${APP} is listening on 127.0.0.1:${port}.`));
      let stopping = false;
      const stop = async () => { if (stopping) return; stopping = true; await server.close(); await store.queue; await release(); process.exit(0); };
      server.shutdown = stop;
      process.on('SIGTERM', stop); process.on('SIGINT', stop);
      if (args.includes('--parent-pipe')) {
        process.stdin.once('end', stop);
        process.stdin.resume();
      }
    } catch (e) { await release(); throw e; }
    return;
  }
  if (command === 'install') {
    if (process.platform !== 'darwin') throw new RouterError('此平台请使用便携启动脚本，或运行 node cli.mjs serve');
    const destination = join(homedir(), '.local', 'share', 'codex-plan-router');
    const result = await installService(source, destination, stateDir, process.execPath);
    console.log(JSON.stringify(result, null, 2)); return;
  }
  if (command === 'launch') {
    if (!await listening()) {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', '--state', stateDir, '--port', String(port)], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      const started = new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      await started;
      child.unref();
      const deadline = Date.now() + 7000;
      while (!await listening()) {
        if (Date.now() >= deadline) throw new RouterError('后台启动失败，请检查端口或现有实例');
        await delay(150);
      }
    }
    await openDashboard();
    return;
  }
  if (command === 'dashboard') { await openDashboard(); return; }
  if (command === 'stop') {
    const restore = args.includes('--restore-direct');
    if (await listening()) {
      await admin('shutdown', { restore });
      const deadline = Date.now() + 5000;
      while (await listening()) {
        if (Date.now() >= deadline) throw new RouterError('后台仍在退出，请稍后重试');
        await delay(100);
      }
    } else if (restore) {
      const store = await runningStore().catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (store) await new DesktopConfig(store, port).disable();
    }
    return;
  }
  if (command === 'status') { console.log(JSON.stringify(await admin('status'), null, 2)); return; }
  if (command === 'verify') { console.log(JSON.stringify(await admin('verify', { slot: args[1] }), null, 2)); return; }
  if (command === 'enable') { console.log((await admin('enable', {})).message); return; }
  if (command === 'disable') {
    // 服务意外停止时，仍可离线移除本工具管理的配置块。
    const store = await runningStore();
    const config = new DesktopConfig(store, port);
    await config.disable(); console.log(localizeMessage('已移除代理配置，请在任务结束后重新打开客户端。', language)); return;
  }
  console.log(bilingual(language, '用法：node cli.mjs <install|launch|dashboard|stop|status|verify <账号编号>|enable|disable|serve> [--state 目录] [--port 端口]\n首次使用：install → dashboard → 连接并验证至少两个账号 → 启用 → 任务结束后手动重新打开桌面客户端。', 'Usage: node cli.mjs <install|launch|dashboard|stop|status|verify <account-slot>|enable|disable|serve> [--state DIR] [--port PORT]'));
}
main().catch(e => { console.error(localizeMessage(e instanceof RouterError ? e.message : '操作失败，请检查网络、文件权限或后台服务状态。', language)); process.exitCode = 1; });
