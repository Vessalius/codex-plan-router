import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { accountSlots, atomicJSON, hash, officialFetch } from './core.mjs';
import { withAccount } from './quota-native.mjs';

import { codexDirectory, stateDirectory as defaultStateDirectory } from './platform.mjs';

const directory = defaultStateDirectory();
const nativePath = join(codexDirectory(), 'auth.json');
export const QUOTA_QUERY_CONCURRENCY = 4;

export function quotaWindow(window, expectedSeconds, now = Date.now()) {
  if (!window || window.limit_window_seconds !== expectedSeconds || !Number.isFinite(window.used_percent) || window.used_percent < 0 || window.used_percent > 100) return null;
  if (Number.isFinite(window.reset_at) && window.reset_at * 1000 <= now) return null;
  return { remainingPercent: Math.max(0, Math.min(100, 100 - window.used_percent)), resetsAt: Number.isFinite(window.reset_at) ? window.reset_at * 1000 : null };
}

export function normalizeQuota(payload, accounts, now = Date.now()) {
  const windows = [payload?.rate_limit?.primary_window, payload?.rate_limit?.secondary_window];
  const email = typeof payload?.email === 'string' ? payload.email.toLowerCase() : '';
  const match = Object.entries(accounts).find(([, a]) => email && a?.email?.toLowerCase() === email);
  const slot = match?.[0] ?? null;
  return {
    status: 'ready', source: 'official_native_usage', updatedAt: now,
    slot, registration: match ? hash(`${match[1].subject}:${match[1].clientId}`) : null,
    fiveHour: windows.map(w => quotaWindow(w, 18000, now)).find(Boolean) ?? null,
    weekly: windows.map(w => quotaWindow(w, 604800, now)).find(Boolean) ?? null,
  };
}

export function validCache(cache, owner, accounts, now = Date.now()) {
  if (!cache || cache.owner !== owner || !Number.isFinite(cache.updatedAt) || cache.updatedAt > now || now - cache.updatedAt > 15 * 60_000) return null;
  if (cache.slot) {
    const a = accounts[cache.slot];
    if (!a || cache.registration !== hash(`${a.subject}:${a.clientId}`)) return null;
  }
  const result = { ...cache };
  for (const name of ['fiveHour', 'weekly']) if (result[name]?.resetsAt && result[name].resetsAt <= now) result[name] = null;
  return result;
}

export async function readQuota({ fetcher = officialFetch, authPath = nativePath, stateDirectory = directory, now = () => Date.now(), force = false } = {}) {
  const cachePath = join(stateDirectory, 'quota-cache.json');
  let native, store, cache, owner;
  try {
    [native, store, cache] = await Promise.all([
      readFile(authPath, 'utf8').then(JSON.parse),
      readFile(join(stateDirectory, 'state.json'), 'utf8').then(JSON.parse),
      readFile(cachePath, 'utf8').then(JSON.parse).catch(() => null),
    ]);
    const tokens = native.tokens;
    if (!['chatgpt', 'chatgptAuthTokens'].includes(native.auth_mode) || !tokens?.access_token || !tokens.account_id) throw new Error('native_login_unavailable');
    owner = hash(tokens.account_id);
    const previous = validCache(cache, owner, store.accounts, now());
    if (!force && previous && now() - previous.updatedAt < 45_000) return previous;
    // 只使用当前原生登录做只读额度查询，不复制、轮换或刷新原生令牌。
    // SIWC 推理令牌不用于 ChatGPT 后端接口。
    const response = await fetcher('https://chatgpt.com/backend-api/wham/usage', {
      headers: { authorization: `Bearer ${tokens.access_token}`, 'chatgpt-account-id': tokens.account_id, accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`quota_http_${response.status}`);
    const payload = await response.json();
    if (payload.account_id !== tokens.account_id) throw new Error('quota_identity_mismatch');
    const result = { ...normalizeQuota(payload, store.accounts, now()), owner };
    await atomicJSON(cachePath, result);
    return result;
  } catch {
    const previous = owner && store ? validCache(cache, owner, store.accounts, now()) : null;
    if (previous) return { ...previous, status: 'stale', reason: '官方额度暂不可用，显示上次查询值' };
    return { status: 'unavailable', source: 'official_native_usage', updatedAt: null, slot: null, fiveHour: null, weekly: null, reason: '当前原生登录的官方额度暂未获取；不会估算剩余额度' };
  }
}

export async function readAllQuotas({ stateDirectory = directory, nativeReader = readQuota, isolatedReader = withAccount, force = false, now = () => Date.now() } = {}) {
  const store = JSON.parse(await readFile(join(stateDirectory, 'state.json'), 'utf8'));
  const native = await nativeReader({ stateDirectory, force });
  const slots = accountSlots(store.accounts);
  const readSlot = async slot => {
    if (native.slot === slot && native.status === 'ready') return native;
    const cachePath = join(stateDirectory, `quota-cache-${slot}.json`);
    const registration = store.accounts[slot] ? hash(`${store.accounts[slot].subject}:${store.accounts[slot].clientId}`) : null;
    const owner = `isolated:${slot}:${registration}`;
    const cache = await readFile(cachePath, 'utf8').then(JSON.parse).catch(() => null);
    const previous = validCache(cache, owner, store.accounts, now());
    if (!force && previous && now() - previous.updatedAt < 45_000) return previous;
    try {
      const payload = await isolatedReader(slot, { directory: stateDirectory });
      const snapshot = normalizeQuota(payload, store.accounts, now());
      if (snapshot.slot !== slot) throw new Error('quota_identity_mismatch');
      const complete = { ...snapshot, owner, source: 'official_isolated_codex_usage' };
      await atomicJSON(cachePath, complete);
      return complete;
    } catch {
      if (native.slot === slot && native.status === 'stale') return native;
      if (previous) return { ...previous, status: 'stale', reason: '官方额度暂不可用，显示上次查询值' };
      return { slot, status: 'unavailable', updatedAt: null, fiveHour: null, weekly: null, source: 'official_isolated_codex_usage', reason: '尚未完成此账号的独立 Codex 登录，或独立授权需要更新' };
    }
  };
  // 限制同时运行的 Codex 子进程，避免账号较多时集中占用资源。
  const result = new Array(slots.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(QUOTA_QUERY_CONCURRENCY, slots.length) }, async () => {
    while (next < slots.length) {
      const index = next++;
      result[index] = await readSlot(slots[index]);
    }
  }));
  return { accounts: result.map(({ owner, registration, ...summary }) => summary) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--all')) {
    const state = process.argv.indexOf('--state');
    const result = await readAllQuotas({ stateDirectory: state < 0 ? directory : process.argv[state + 1], force: process.argv.includes('--force') });
    if (!process.argv.includes('--quiet')) process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const result = await readQuota({ force: process.argv.includes('--force') });
    // 输出只有额度摘要，包含认证信息的文件不会返回给菜单栏界面。
    const { owner, registration, ...summary } = result;
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  }
}
