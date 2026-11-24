import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Scheduler, hash } from '../core.mjs';
import { allocationQuota, quotaPriority, readAllocationCaches, QUOTA_MAX_AGE } from '../allocation.mjs';

const now = 1795500000000;
const body = { input: [{ role: 'user', content: 'test' }] };
function setup() {
  const accounts = Object.fromEntries(['a', 'b'].map(slot => [slot, { subject: slot, clientId: `client-${slot}`, enabled: true, verified: true }]));
  const store = { data: { accounts, usage: [], opaque: {} } };
  const scheduler = new Scheduler(store, () => now);
  return { accounts, store, scheduler };
}
function snapshot(accounts, slot, five = 80, week = 80, fiveTime = 5, weekTime = 168) {
  return { slot, source: 'official_native_usage', registration: hash(`${accounts[slot].subject}:${accounts[slot].clientId}`), updatedAt: now, fiveHour: { remainingPercent: five, resetsAt: now + fiveTime * 3600_000 }, weekly: { remainingPercent: week, resetsAt: now + weekTime * 3600_000 } };
}
test('新请求优先使用官方余量，覆盖仅按本地消耗选择的旧策略', () => {
  const { accounts, store, scheduler: s } = setup();
  store.data.usage.push({ slot: 'a', at: now, input: 100000, output: 100000 });
  assert.equal(s.select(body), 'b');
  s.quotas = { a: snapshot(accounts, 'a', 80, 85), b: snapshot(accounts, 'b', 35, 90) };
  assert.equal(s.select(body), 'a'); assert.equal(s.lastDecision.basis, 'official_quota');
});
test('每周短缺会压低优先级，避免只看五小时剩余', () => {
  const { accounts, scheduler: s } = setup();
  s.quotas = { a: snapshot(accounts, 'a', 95, 5), b: snapshot(accounts, 'b', 45, 90) };
  assert.equal(s.select(body), 'b');
});
test('接近重置的未用额度适度优先，重置加权最多两倍', () => {
  const { accounts, scheduler: s } = setup();
  s.quotas = { a: snapshot(accounts, 'a', 40, 90, 1, 168), b: snapshot(accounts, 'b', 60, 90) };
  assert.equal(s.select(body), 'a');
  const q = s.officialQuota('a'); assert.equal(quotaPriority(q, 0, now), 80);
  s.quotas.a.weekly.remainingPercent = 5;
  assert.equal(s.select(body), 'b');
});
test('官方五小时或每周已耗尽时停止新分配，不能伪装重置或改发其他身份', () => {
  const { accounts, scheduler: s } = setup();
  s.quotas = { a: snapshot(accounts, 'a', 0, 90), b: snapshot(accounts, 'b', 50, 0) };
  assert.equal(s.select(body), null);
  delete s.quotas.b; assert.equal(s.select(body), 'b');
  s.store.data.opaque[hash('a-context')] = { slot: 'a', at: now };
  assert.throws(() => s.select({ input: [{ encrypted_content: 'a-context' }] }), /所属账号暂不可用/);
});
test('上下文固定账号；额度较少也不强制切换，主号历史仍归主号', () => {
  const { accounts, scheduler: s } = setup();
  s.quotas = { a: snapshot(accounts, 'a', 10, 10), b: snapshot(accounts, 'b', 99, 99) };
  s.store.data.opaque[hash('a-context')] = { slot: 'a', at: now };
  assert.equal(s.select({ input: [{ encrypted_content: 'a-context' }] }), 'a');
  assert.equal(s.select({ input: [{ encrypted_content: 'unknown-primary' }] }), 'primary');
});
test('过期、未来、账号重绑或已过重置的数据不得用于调度', () => {
  const { accounts, scheduler: s } = setup();
  const a = snapshot(accounts, 'a');
  assert.equal(allocationQuota({ ...a, updatedAt: now - QUOTA_MAX_AGE - 1 }, 'a', accounts.a, now), null);
  assert.equal(allocationQuota({ ...a, updatedAt: now + 1 }, 'a', accounts.a, now), null);
  assert.equal(allocationQuota(a, 'b', accounts.b, now), null);
  assert.equal(allocationQuota(a, 'a', { ...accounts.a, subject: 'other' }, now), null);
  s.quotas = { a: { ...a, fiveHour: { remainingPercent: 0, resetsAt: now - 1 } }, b: snapshot(accounts, 'b') };
  assert.equal(s.officialQuota('a').fiveHour, null); assert.equal(s.select(body), 'a'); assert.equal(s.lastDecision.basis, 'observed_usage_fallback');
});
test('并发请求预留余量，同分时沿用本地用量和轮转次序', () => {
  const { accounts, store, scheduler: s } = setup();
  s.quotas = { a: snapshot(accounts, 'a'), b: snapshot(accounts, 'b') };
  s.inFlight.a = 1; assert.equal(s.select(body), 'b');
  s.inFlight.a = 0; store.data.accounts.a.lastUsed = now; assert.equal(s.select(body), 'b');
});
test('缓存读取为每个已验证注册挑选最新快照，损坏文件不影响请求', async t => {
  const { accounts } = setup(); const dir = await mkdtemp(join(tmpdir(), 'router-allocation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const older = snapshot(accounts, 'a', 50); older.updatedAt -= 60000;
  await writeFile(join(dir, 'quota-cache.json'), JSON.stringify(older));
  await writeFile(join(dir, 'quota-cache-a.json'), JSON.stringify(snapshot(accounts, 'a', 40)));
  await writeFile(join(dir, 'quota-cache-b.json'), 'broken');
  const quotas = await readAllocationCaches(dir, accounts, now);
  assert.equal(quotas.a.fiveHour.remainingPercent, 40); assert.equal(quotas.b, undefined);
});
