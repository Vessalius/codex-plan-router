import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const home = homedir();
const macCodex = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';

export function stateDirectory() {
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Codex Plan Router');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Codex Plan Router');
  return join(process.env.XDG_STATE_HOME || join(home, '.local', 'state'), 'codex-plan-router');
}

export function codexDirectory() {
  return resolve(process.env.CODEX_HOME || join(home, '.codex'));
}

export function codexExecutable() {
  if (process.env.CODEX_ROUTER_CODEX_BIN) return resolve(process.env.CODEX_ROUTER_CODEX_BIN);
  if (process.platform === 'darwin' && existsSync(macCodex)) return macCodex;
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

export function pythonCommand() {
  if (process.env.CODEX_ROUTER_PYTHON) return [resolve(process.env.CODEX_ROUTER_PYTHON), []];
  return process.platform === 'win32' ? ['py.exe', ['-3']] : ['python3', []];
}

export async function openBrowser(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) {
    throw new Error('浏览器地址无效');
  }
  if (process.platform === 'darwin') return exec('/usr/bin/open', [url.href]);
  if (process.platform === 'win32') return exec('rundll32.exe', ['url.dll,FileProtocolHandler', url.href]);
  return exec('xdg-open', [url.href]);
}
