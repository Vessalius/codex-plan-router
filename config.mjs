import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RouterError, hash } from './core.mjs';
import { codexDirectory, pythonCommand } from './platform.mjs';

const exec = promisify(execFile);
const START = '# BEGIN CODEX PLAN ROUTER';
const END = '# END CODEX PLAN ROUTER';
export class DesktopConfig {
  constructor(store, port, path = join(codexDirectory(), 'config.toml')) { this.store = store; this.port = port; this.path = path; }
  async text() { return readFile(this.path, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; }); }
  async inspect(text) {
    const script = 'import sys,tomllib,json;d=tomllib.loads(sys.stdin.read());print(json.dumps({"provider":d.get("model_provider","openai"),"has_openai":"openai" in d.get("model_providers",{}),"has_base":"openai_base_url" in d}))';
    return new Promise((resolve, reject) => {
      const [python, pythonArgs] = pythonCommand();
      const child = execFile(python, [...pythonArgs, '-c', script], { timeout: 10000 }, (error, stdout) => {
        if (error) reject(new RouterError('无法验证现有配置；需要带 tomllib 的 Python 3.11 或更高版本', 500));
        else { try { resolve(JSON.parse(stdout)); } catch { reject(new RouterError('配置验证失败', 500)); } }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(text);
    });
  }
  block() {
    return `${START}\nopenai_base_url = "http://127.0.0.1:${this.port}/bridge/${this.store.data.bridgeKey}/v1"\n${END}\n`;
  }
  async write(text) {
    await this.inspect(text);
    const temp = `${this.path}.${randomUUID()}.tmp`;
    await mkdir(join(this.path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(temp, text, { flag: 'wx', mode: 0o600 });
    await rename(temp, this.path); await chmod(this.path, 0o600);
  }
  async status() {
    const text = await this.text(), block = this.block();
    return { enabled: text.includes(block), modified: text.includes(START) && !text.includes(block), configPath: this.path };
  }
  async enable() {
    if (Object.values(this.store.data.accounts).filter(a => a.verified && a.enabled && !a.needsLogin).length < 2) throw new RouterError('请先登录并验证至少两个不同账号');
    const before = await this.text(), block = this.block();
    if (before.includes(block)) return;
    if (before.includes(START)) throw new RouterError('已有代理配置经过改动，请先手动检查');
    const info = await this.inspect(before);
    if (info.provider !== 'openai' || info.has_openai || info.has_base) throw new RouterError('已有自定义模型提供商或请求地址配置，未自动覆盖');
    const backup = join(this.store.dir, `config-backup-${Date.now()}.toml`);
    await writeFile(backup, before, { flag: 'wx', mode: 0o600 });
    const text = `${block}\n${before}`;
    if (await this.text() !== before) throw new RouterError('配置刚刚被其他程序修改，请重试');
    await this.write(text);
    this.store.data.activation = { at: Date.now(), beforeHash: hash(before), backup };
    await this.store.save();
  }
  async disable() {
    const before = await this.text(), block = this.block();
    if (!before.includes(START)) return;
    if (!before.includes(block)) throw new RouterError('代理配置已被手动修改，未覆盖你的改动');
    await this.write(before.replace(block, ''));
  }
}

export function localProxyEnvironment(env) {
  const result = { NODE_USE_ENV_PROXY: '1', NO_PROXY: 'localhost,127.0.0.1,::1' };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    if (!env[key]) continue;
    let u; try { u = new URL(env[key]); } catch { throw new RouterError('网络代理地址格式无效，未保存网络配置'); }
    if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new RouterError('自启动只支持不含凭据和附加数据的本机回环代理地址，未保存现有网络环境');
    result[key] = u.origin;
  }
  return result;
}
export async function installService(source, destination, stateDir, nodePath, { start = true } = {}) {
  const localEnv = localProxyEnvironment(process.env);
  if (process.env.CODEX_ROUTER_PYTHON) localEnv.CODEX_ROUTER_PYTHON = resolve(process.env.CODEX_ROUTER_PYTHON);
  const { cp } = await import('node:fs/promises');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of ['cli.mjs', 'core.mjs', 'allocation.mjs', 'config.mjs', 'server.mjs', 'ui.mjs', 'quota.mjs', 'quota-native.mjs', 'platform.mjs', 'i18n.mjs', 'package.json', 'README.md']) await cp(join(source, name), join(destination, name));
  const launcher = `#!/bin/zsh\nexec '${nodePath.replaceAll("'", "'\\''")}' '${join(destination, 'cli.mjs').replaceAll("'", "'\\''")}' dashboard\n`;
  await writeFile(join(destination, '打开设置.command'), launcher, { mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const label = 'com.sun.codex-plan-router';
  const agentDir = join(homedir(), 'Library', 'LaunchAgents');
  await mkdir(agentDir, { recursive: true });
  const path = join(agentDir, `${label}.plist`);
  const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const args = [nodePath, join(destination, 'cli.mjs'), 'serve', '--state', stateDir].map(s => `<string>${xml(s)}</string>`).join('');
  // 只持久化已经验证不含凭据的回环地址，不复制其他环境或远端代理。
  const networkEnv = Object.entries(localEnv).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>${networkEnv}</dict><key>StandardOutPath</key><string>${xml(join(stateDir, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(stateDir, 'service.log'))}</string></dict></plist>\n`;
  await writeFile(path, plist, { mode: 0o600 });
  await exec('/usr/bin/plutil', ['-lint', path]);
  if (start) {
    const domain = `gui/${process.getuid()}`;
    await exec('/bin/launchctl', ['bootout', `${domain}/${label}`]).catch(() => {});
    // 卸载成功后旧进程可能尚在退出，给 launchd 有限的重载等待。
    let failure;
    for (const delay of [0, 250, 750, 1500]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      try { await exec('/bin/launchctl', ['bootstrap', domain, path]); failure = null; break; }
      catch (e) { failure = e; }
    }
    if (failure) throw new RouterError('程序已安装，但自启动服务重载失败；请稍后重新运行 install', 500);
    let ready = false;
    for (const delay of [50, 100, 200, 400, 800, 1500]) {
      await new Promise(resolve => setTimeout(resolve, delay));
      try { const r = await fetch('http://127.0.0.1:47631/health', { signal: AbortSignal.timeout(1000) }); ready = r.ok && (await r.json()).app === 'Codex Plan Router'; if (ready) break; }
      catch {
        // 启动期间短暂拒绝连接，继续有限等待。
      }
    }
    if (!ready) throw new RouterError('服务已加载，但尚未通过就绪检查，请查看本地服务日志', 500);
  }
  return { path, destination, stateDir };
}
