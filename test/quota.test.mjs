import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeQuota, quotaWindow, validCache, readQuota, readAllQuotas } from '../quota.mjs';
import { hash } from '../core.mjs';
import { checkedPayload, isolatedEnvironment, isolatedDirectory } from '../quota-native.mjs';

const now = 1795500000000;
const accounts = { a: { email: 'main@example.invalid', subject: 'verified-a', clientId: 'registered-a' }, b: { email: 'second@example.invalid', subject: 'verified-b', clientId: 'registered-b' } };
const payload = { account_id: 'native-main', email: 'main@example.invalid', rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: now / 1000 + 3600 }, secondary_window: { used_percent: 35, limit_window_seconds: 604800, reset_at: now / 1000 + 86400 } } };

test('官方使用百分比转换为剩余，按窗口时长区分五小时与每周', () => {
  const result = normalizeQuota(payload, accounts, now);
  assert.equal(result.slot, 'a'); assert.equal(result.fiveHour.remainingPercent, 90); assert.equal(result.weekly.remainingPercent, 65);
  const swapped = normalizeQuota({ ...payload, rate_limit: { primary_window: payload.rate_limit.secondary_window, secondary_window: payload.rate_limit.primary_window } }, accounts, now);
  assert.deepEqual(swapped.fiveHour, result.fiveHour); assert.deepEqual(swapped.weekly, result.weekly);
});
test('缺失、非法、错误窗口或已过重置时间的数据绝不显示为百分之百', () => {
  for (const window of [null, {}, { used_percent: 20, limit_window_seconds: 60 }, { used_percent: NaN, limit_window_seconds: 18000 }, { used_percent: -1, limit_window_seconds: 18000 }, { used_percent: 101, limit_window_seconds: 18000 }, { used_percent: 0, limit_window_seconds: 18000, reset_at: now / 1000 - 1 }]) assert.equal(quotaWindow(window, 18000, now), null);
  assert.equal(normalizeQuota({}, accounts, now).fiveHour, null);
  assert.equal(normalizeQuota({ ...payload, email: 'different@example.invalid' }, accounts, now).slot, null);
});
test('缓存不得跨原生账号或 SIWC 注册复用，已重置窗口只显示未获取', () => {
  const cache = { ...normalizeQuota(payload, accounts, now), owner: hash('native-main') };
  assert.equal(validCache(cache, hash('other'), accounts, now), null);
  assert.equal(validCache(cache, hash('native-main'), { ...accounts, a: { ...accounts.a, subject: 'replaced' } }, now), null);
  assert.equal(validCache(cache, hash('native-main'), accounts, now + 16 * 60000), null);
  const expired = { ...cache, fiveHour: { remainingPercent: 90, resetsAt: now - 1 } };
  assert.equal(validCache(expired, hash('native-main'), accounts, now).fiveHour, null);
});
test('只读原生登录查询官方额度，不修改原生凭证、不把 SIWC 令牌发到后端', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'router-quota-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authPath = join(dir, 'native-auth.json');
  const native = JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'native-main', access_token: 'native-access', refresh_token: 'must-not-touch' } });
  await writeFile(authPath, native);
  await writeFile(join(dir, 'state.json'), JSON.stringify({ accounts: { ...accounts, a: { ...accounts.a, accessToken: 'SIWC-never-use-here' } } }));
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++; assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(options.headers.authorization, 'Bearer native-access');
    assert.equal(options.headers['chatgpt-account-id'], 'native-main');
    assert.equal(options.method, undefined); assert.equal(options.body, undefined);
    return Response.json(payload);
  };
  const options = { authPath, stateDirectory: dir, fetcher, now: () => now };
  const result = await readQuota(options);
  assert.equal(result.status, 'ready'); assert.equal(result.weekly.remainingPercent, 65);
  const cached = await readQuota(options); assert.equal(calls, 1); assert.equal(cached.status, 'ready');
  assert.equal(await readFile(authPath, 'utf8'), native);
  const saved = await readFile(join(dir, 'quota-cache.json'), 'utf8');
  assert.ok(!saved.includes('native-access') && !saved.includes('must-not-touch') && !saved.includes('SIWC-'));
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'quota-cache.json'))).mode & 0o777, 0o600);
  const stale = await readQuota({ ...options, now: () => now + 60_000, fetcher: async () => Response.json({}, { status: 401 }) });
  assert.equal(stale.status, 'stale'); assert.equal(stale.fiveHour.remainingPercent, 90);
  const unavailable = await readQuota({ ...options, now: () => now + 16 * 60_000, fetcher: async () => Response.json({}, { status: 401 }) });
  assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.fiveHour, null);
});

test('B 原生登录在专用目录中，不继承桌面运行时、主号环境或 API 凭证', () => {
  const directory = isolatedDirectory('b', '/private/tmp/test-state');
  assert.equal(directory, join('/private/tmp/test-state', 'quota-native-b'));
  const env = isolatedEnvironment(directory, { HOME: '/Users/example', CODEX_HOME: '/Users/example/.codex', CODEX_APP_TOOLS_PIPE_PATH: 'desktop-socket', CODEX_THREAD_ID: 'desktop', OPENAI_API_KEY: 'never-inherit', HTTPS_PROXY: 'http://127.0.0.1:7890' });
  assert.equal(env.CODEX_HOME, directory); assert.equal(env.CODEX_APP_TOOLS_PIPE_PATH, undefined); assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.CODEX_THREAD_ID, undefined);
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.throws(() => isolatedDirectory('../bad', '/tmp'));
});

test('独立登录必须匹配已保存的 B 身份，不接受把 A 的额度记到 B', () => {
  const limits = { rateLimitsByLimitId: { codex: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: now / 1000 + 3600 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: now / 1000 + 86400 } } } };
  const account = { account: { type: 'chatgpt', email: accounts.b.email } };
  const body = checkedPayload('b', accounts.b, account, limits);
  const result = normalizeQuota(body, accounts, now);
  assert.equal(result.slot, 'b'); assert.equal(result.fiveHour.remainingPercent, 75); assert.equal(result.weekly.remainingPercent, 60);
  assert.throws(() => checkedPayload('b', accounts.b, { account: { type: 'chatgpt', email: accounts.a.email } }, limits), /不是账号 B/);
});

test('两个账号各自显示官方窗口；B 独立查询故障时不使用 A 的数值冒充', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'router-all-quota-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'state.json'), JSON.stringify({ accounts }));
  const native = normalizeQuota(payload, accounts, now);
  let calls = [];
  const opts = {
    stateDirectory: dir, now: () => now,
    nativeReader: async () => native,
    isolatedReader: async slot => {
      calls.push(slot); return { ...payload, email: accounts.b.email, rate_limit: { primary_window: { ...payload.rate_limit.primary_window, used_percent: 80 }, secondary_window: { ...payload.rate_limit.secondary_window, used_percent: 90 } } };
    },
  };
  const result = await readAllQuotas(opts);
  assert.deepEqual(calls, ['b']);
  assert.equal(result.accounts[0].fiveHour.remainingPercent, 90); assert.equal(result.accounts[1].fiveHour.remainingPercent, 20); assert.equal(result.accounts[1].weekly.remainingPercent, 10);
  assert.equal(result.accounts[1].owner, undefined); assert.equal(result.accounts[1].registration, undefined);
  const cached = await readAllQuotas(opts); assert.deepEqual(calls, ['b']); assert.equal(cached.accounts[1].status, 'ready');
  const failed = await readAllQuotas({ ...opts, now: () => now + 60000, isolatedReader: async () => { throw new Error('temporary'); } });
  assert.equal(failed.accounts[1].status, 'stale'); assert.equal(failed.accounts[1].fiveHour.remainingPercent, 20);
  const expired = await readAllQuotas({ ...opts, now: () => now + 16 * 60000, isolatedReader: async () => { throw new Error('temporary'); } });
  assert.equal(expired.accounts[1].status, 'unavailable'); assert.equal(expired.accounts[1].fiveHour, null);
});

test('桌面当前切换到 B 后仍独立查询并显示 A 的额度', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'router-switched-quota-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'state.json'), JSON.stringify({ accounts }));
  const nativeB = normalizeQuota({ ...payload, email: accounts.b.email, account_id: 'native-b' }, accounts, now);
  const calls = [];
  const result = await readAllQuotas({
    stateDirectory: dir, now: () => now, nativeReader: async () => nativeB,
    isolatedReader: async slot => {
      calls.push(slot);
      if (slot !== 'a') throw new Error('B should use the matching current native login');
      return { ...payload, account_id: 'isolated-a' };
    },
  });
  assert.deepEqual(calls, ['a']);
  assert.equal(result.accounts[0].slot, 'a');
  assert.equal(result.accounts[0].fiveHour.remainingPercent, 90);
  assert.equal(result.accounts[1].slot, 'b');
  assert.equal(result.accounts[1].fiveHour.remainingPercent, 90);
});
