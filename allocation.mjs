import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const QUOTA_MAX_AGE = 180_000;
const fingerprint = account => createHash('sha256').update(`${account.subject}:${account.clientId}`).digest('hex');

export function allocationQuota(snapshot, slot, account, now = Date.now()) {
  if (!snapshot || !account || snapshot.slot !== slot || snapshot.registration !== fingerprint(account) || !['official_native_usage', 'official_isolated_codex_usage'].includes(snapshot.source) || !Number.isFinite(snapshot.updatedAt) || snapshot.updatedAt > now || now - snapshot.updatedAt > QUOTA_MAX_AGE) return null;
  const window = value => {
    if (!value || !Number.isFinite(value.remainingPercent) || value.remainingPercent < 0 || value.remainingPercent > 100) return null;
    if (value.resetsAt !== null && value.resetsAt !== undefined && (!Number.isFinite(value.resetsAt) || value.resetsAt <= now)) return null;
    return { remainingPercent: value.remainingPercent, resetsAt: value.resetsAt ?? null };
  };
  const fiveHour = window(snapshot.fiveHour), weekly = window(snapshot.weekly);
  return { fiveHour, weekly, updatedAt: snapshot.updatedAt, exhausted: fiveHour?.remainingPercent === 0 || weekly?.remainingPercent === 0, complete: !!fiveHour && !!weekly };
}

export function quotaPriority(quota, inFlight = 0, now = Date.now()) {
  if (!quota?.complete || quota.exhausted) return null;
  const pace = (window, duration) => {
    const timeLeft = window.resetsAt ? window.resetsAt - now : duration;
    // 越临近重置越适合使用，但重置加权最多两倍，避免压过另一窗口的短缺。
    const resetWeight = Math.max(1, Math.min(2, duration / Math.max(timeLeft, 1)));
    return window.remainingPercent * resetWeight;
  };
  return Math.min(pace(quota.fiveHour, 5 * 3600_000), pace(quota.weekly, 7 * 24 * 3600_000)) - inFlight * 5;
}

export async function readAllocationCaches(directory, accounts, now = Date.now()) {
  const files = ['quota-cache.json', ...Object.keys(accounts).filter(slot => /^[a-z]{1,8}$/.test(slot)).map(slot => `quota-cache-${slot}.json`)];
  const results = await Promise.all(files.map(name => readFile(join(directory, name), 'utf8').then(JSON.parse).catch(() => null)));
  const selected = {};
  for (const snapshot of results) {
    const slot = snapshot?.slot;
    if (!Object.hasOwn(accounts, slot) || !allocationQuota(snapshot, slot, accounts[slot], now)) continue;
    if (!selected[slot] || selected[slot].updatedAt < snapshot.updatedAt) selected[slot] = snapshot;
  }
  return selected;
}
