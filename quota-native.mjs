import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, chmod, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isAccountSlot } from './core.mjs';

import { codexExecutable, openBrowser as openURL, stateDirectory as defaultStateDirectory } from './platform.mjs';

export const stateDirectory = defaultStateDirectory();
export const isolatedDirectory = (slot, directory = stateDirectory) => {
  if (!isAccountSlot(slot)) throw new Error('账号位置无效');
  return join(directory, `quota-native-${slot}`);
};

export function isolatedEnvironment(directory, environment = process.env) {
  const result = Object.fromEntries(Object.entries(environment).filter(([key]) => !/^(CODEX_|OPENAI_)/.test(key)));
  result.CODEX_HOME = directory;
  result.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'codex_plan_router_quota';
  return result;
}

class AccountClient {
  constructor(directory) {
    this.nextId = 1; this.pending = new Map(); this.notifications = []; this.listeners = new Set(); this.buffer = '';
    this.child = spawn(codexExecutable(), ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"', '-c', 'features.secret_auth_storage=false', '-c', 'features.apps=false', '-c', 'features.plugins=false'], {
      cwd: directory, env: isolatedEnvironment(directory), stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (this.buffer.length > 4 * 1024 * 1024) { this.fail(); this.child.kill(); return; }
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (value.id !== undefined && !value.method) {
          const p = this.pending.get(value.id); if (!p) continue;
          clearTimeout(p.timer); this.pending.delete(value.id);
          if (value.error) p.reject(new Error('独立 Codex 账号请求未能完成，请检查授权状态'));
          else p.resolve(value.result);
        } else if (value.method && value.id === undefined) {
          this.notifications.push(value); if (this.notifications.length > 30) this.notifications.shift();
          for (const listener of this.listeners) listener(value);
        }
      }
    });
    this.child.on('error', () => this.fail());
    this.child.on('exit', () => this.fail());
    // 不允许账号管理子进程把原始认证错误或凭证写入界面与日志。
  }
  fail() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('独立账号服务连接已关闭')); }
    this.pending.clear();
  }
  request(method, params, timeout = 30_000) {
    if (!['initialize', 'account/read', 'account/login/start', 'account/login/cancel', 'account/logout', 'account/rateLimits/read'].includes(method)) throw new Error('额度工具不允许执行此操作');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('独立账号服务请求超时')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error('无法连接独立账号服务')); }
      });
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'codex_plan_router_quota', title: 'Codex 额度查询', version: '0.4.0' }, capabilities: {} });
    this.child.stdin.write('{"method":"initialized"}\n');
  }
  completed(loginId, timeout = 600_000) {
    return new Promise((resolve, reject) => {
      const listener = value => {
        if (value.method !== 'account/login/completed' || value.params?.loginId !== loginId) return;
        clearTimeout(timer); this.listeners.delete(listener);
        if (value.params.success) resolve(); else reject(new Error('登录未完成，请重新授权'));
      };
      const timer = setTimeout(() => { this.listeners.delete(listener); reject(new Error('等待浏览器授权超时，请重新打开授权入口')); }, timeout);
      this.listeners.add(listener);
      for (const value of this.notifications) listener(value);
    });
  }
  close() {
    this.child.stdin.end();
    const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGTERM'); }, 1500);
    timer.unref();
    this.fail();
  }
}

async function lockDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const path = join(directory, 'quota.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await writeFile(path, String(process.pid), { flag: 'wx', mode: 0o600 }); return () => unlink(path).catch(() => {}); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('独立账号锁文件需要检查');
      try { process.kill(pid, 0); throw new Error('此账号正在授权或刷新，请稍后重试'); }
      catch (e) { if (e.code === 'ESRCH') await unlink(path); else throw e; }
    }
  }
  throw new Error('独立账号服务忙');
}

export function checkedPayload(slot, expected, account, limits) {
  if (!expected?.email || account?.account?.type !== 'chatgpt' || account.account.email?.toLowerCase() !== expected.email.toLowerCase()) throw new Error(`登录的不是账号 ${slot.toUpperCase()}，没有将此额度归入该账号。请重新授权并选择正确账号。`);
  const data = limits.rateLimitsByLimitId?.codex ?? limits.rateLimits;
  const convert = window => window ? { used_percent: window.usedPercent, limit_window_seconds: window.windowDurationMins * 60, reset_at: window.resetsAt } : null;
  return { email: account.account.email, account_id: limits.accountId ?? null, rate_limit: { primary_window: convert(data?.primary), secondary_window: convert(data?.secondary) } };
}

export async function withAccount(slot, { directory = stateDirectory, login = false, openBrowser = openURL } = {}) {
  const isolated = isolatedDirectory(slot, directory);
  if (!login) {
    try { await readFile(join(isolated, 'auth.json'), 'utf8'); }
    catch { throw new Error(`账号 ${slot.toUpperCase()} 尚未完成独立 Codex 登录`); }
  }
  const release = await lockDirectory(isolated);
  let client;
  try {
    const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    const expected = state.accounts[slot];
    if (!expected?.email) throw new Error('请先在代理设置中连接此账号');
    client = new AccountClient(isolated);
    await client.initialize();
    if (login) {
      const result = await client.request('account/login/start', { type: 'chatgpt' });
      const url = new URL(result.authUrl);
      if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname)) throw new Error('官方登录地址验证失败');
      // 链接不写入日志；账号选择和同意步骤由用户在官方浏览器页面完成。
      await openBrowser(url.toString());
      console.log(`已打开账号 ${slot.toUpperCase()} 的官方登录页，请选择代理设置中的账号 ${slot.toUpperCase()}。桌面主号不会退出。`);
      await client.completed(result.loginId);
    }
    let account = await client.request('account/read', { refreshToken: false });
    if (account.account?.email?.toLowerCase() !== expected.email.toLowerCase()) {
      if (login) await client.request('account/logout', {}).catch(() => {});
      throw new Error(`登录的不是账号 ${slot.toUpperCase()}，请重新授权并选择正确账号；桌面主号未改动。`);
    }
    // 只对本工具独立登录的会话按需刷新，不触碰桌面原生登录。
    const auth = JSON.parse(await readFile(join(isolated, 'auth.json'), 'utf8'));
    let expires = 0;
    try { expires = JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url')).exp * 1000; } catch { }
    if (!expires || expires < Date.now() + 120_000) account = await client.request('account/read', { refreshToken: true });
    const limits = await client.request('account/rateLimits/read', { excludeResetCreditDetails: true });
    return checkedPayload(slot, expected, account, limits);
  } finally { client?.close(); await release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] !== 'login' || !isAccountSlot(process.argv[3])) throw new Error('用法：node quota-native.mjs login <账号编号>');
    const slot = process.argv[3];
    await withAccount(slot, { login: true });
    console.log(`账号 ${slot.toUpperCase()} 独立授权与官方额度查询成功，菜单栏将在下一次刷新时更新。`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
