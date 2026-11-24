import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { Store, API, hash } from '../core.mjs';
import { RouterServer } from '../server.mjs';

const body = { model: 'test-model', input: [{ role: 'user', content: 'hello' }], store: false, stream: true };
const completed = (id = 'one', output = []) => `data: ${JSON.stringify({ type: 'response.completed', response: { id, output, usage: { input_tokens: 10, output_tokens: 20 } } })}\n\n`;
async function fixture(t, fetcher) {
  const dir = await mkdtemp(join(tmpdir(), 'plan-router-http-'));
  const store = await new Store(dir).init();
  for (const s of ['a', 'b']) store.data.accounts[s] = { enabled: true, verified: true, accessToken: `token-${s}`, expiresAt: Date.now() + 3600_000 };
  const router = new RouterServer(store, { port: 0, fetcher, configPath: join(dir, 'config.toml') });
  // 先由操作系统分配测试端口，再校准 Host 校验和回调地址。
  await router.listen(); router.port = router.server.address().port; router.auth.port = router.port;
  t.after(async () => { router.server.closeAllConnections(); await router.close(); await store.queue; await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${router.port}`;
  const send = (value = body, extra = {}) => fetch(`${base}/bridge/${store.data.bridgeKey}/backend-api/codex/responses`, { method: 'POST', headers: { authorization: 'Bearer PRIMARY-SECRET', 'chatgpt-account-id': 'PRIMARY-ACCOUNT', 'content-type': 'application/json', ...extra }, body: JSON.stringify(value) });
  return { store, router, base, send };
}
test('模型请求使用各自的 SIWC 授权，绝不携带主号路由信息', async t => {
  const calls = [];
  const f = await fixture(t, async (url, opts) => { calls.push({ url, opts }); return new Response(completed(String(calls.length)), { headers: { 'content-type': 'text/event-stream' } }); });
  assert.match(await (await f.send()).text(), /response.completed/);
  assert.match(await (await f.send()).text(), /response.completed/);
  assert.deepEqual(calls.map(c => c.opts.headers.authorization), ['Bearer token-a', 'Bearer token-b']);
  assert.ok(calls.every(c => c.url === `${API}/responses`));
  assert.ok(calls.every(c => !JSON.stringify(c.opts).includes('PRIMARY-')));
  assert.equal(f.store.data.routed, 2);
});
test('未知加密历史或不支持工具直接交还主号，原请求完整保留', async t => {
  const calls = [];
  const f = await fixture(t, async (url, opts) => { calls.push({ url, opts }); return new Response(completed('primary'), { headers: { 'content-type': 'text/event-stream' } }); });
  const unsupported = { ...body, tools: [{ type: 'tool_search' }] };
  await (await f.send(unsupported)).text();
  await (await f.send({ ...body, input: [{ type: 'reasoning', encrypted_content: 'old-primary' }] })).text();
  assert.ok(calls.every(c => c.url === 'https://chatgpt.com/backend-api/codex/responses'));
  assert.equal(calls[0].opts.headers.authorization, 'Bearer PRIMARY-SECRET');
  assert.deepEqual(JSON.parse(calls[0].opts.body), unsupported);
});
test('429 仅在响应流开始前切换，403 不换号或切支付路径', async t => {
  const calls = []; let deny = false;
  const f = await fixture(t, async (_url, opts) => {
    calls.push(opts.headers.authorization);
    if (deny) return Response.json({ error: { code: 'subscription_sharing_user_not_eligible' } }, { status: 403 });
    if (opts.headers.authorization === 'Bearer token-a') return Response.json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, { status: 429, headers: { 'retry-after': '30' } });
    return new Response(completed(), { headers: { 'content-type': 'text/event-stream' } });
  });
  assert.equal((await f.send()).status, 200);
  assert.deepEqual(calls, ['Bearer token-a', 'Bearer token-b']);
  deny = true; const r = await f.send(); await r.text(); assert.equal(r.status, 403); assert.equal(calls.length, 3);
});
test('流内失败和断流不自动换号或重复发送', async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const text = await (await f.send()).text();
  assert.match(text, /partial/); assert.match(text, /response.failed/); assert.equal(calls, 1); assert.equal(f.store.data.routed, 0);
  assert.ok(f.store.data.accounts.a.cooldownUntil > Date.now());
});
test('代理生成的加密内容后续仍发原账号，停用原账号时不泄露给其他账号', async t => {
  const calls = [];
  const f = await fixture(t, async (_url, opts) => { calls.push(opts.headers.authorization); return new Response(completed(String(calls.length), [{ type: 'reasoning', encrypted_content: 'bound-a' }]), { headers: { 'content-type': 'text/event-stream' } }); });
  await (await f.send()).text();
  const bound = { ...body, input: [{ type: 'reasoning', encrypted_content: 'bound-a' }, ...body.input] };
  await (await f.send(bound)).text(); assert.deepEqual(calls, ['Bearer token-a', 'Bearer token-a']);
  f.router.scheduler.pause('a', 10000, 'test');
  const r = await f.send(bound); assert.equal(r.status, 429); await r.text(); assert.equal(calls.length, 2);
});
test('管理和代理接口拒绝缺少密钥、跨站和 DNS 重绑定请求', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return Response.json({}); });
  assert.equal((await fetch(`${f.base}/admin/status`)).status, 401);
  const english = await fetch(`${f.base}/admin/status`, { headers: { 'Accept-Language': 'en' } });
  assert.equal(english.status, 401);
  assert.match((await english.json()).error.message, /Open Settings/);
  const callback = await fetch(`${f.base}/auth/callback?error=access_denied`, { headers: { 'Accept-Language': 'en' } });
  assert.equal(callback.status, 400);
  assert.match(await callback.text(), /Authorization incomplete/);

  const rebound = await new Promise((resolve, reject) => { const req = http.get(`${f.base}/health`, { headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(rebound, 403);
  assert.equal((await f.send(body, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${f.base}/bridge/wrong/backend-api/codex/responses`)).status, 404);
  assert.equal(calls, 0);
});
test('远端压缩不会把代理账号的加密上下文交给主号', async t => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return Response.json({}); });
  await f.router.scheduler.observe('b', { type: 'response.output_item.done', item: { encrypted_content: 'only-b' } });
  const r = await fetch(`${f.base}/bridge/${f.store.data.bridgeKey}/v1/responses/compact`, { method: 'POST', headers: { authorization: 'Bearer PRIMARY-SECRET', 'content-type': 'application/json' }, body: JSON.stringify({ input: [{ type: 'reasoning', encrypted_content: 'only-b' }] }) });
  assert.equal(r.status, 400); assert.match(await r.text(), /unsupported_bound_compaction/); assert.equal(calls, 0);
});
test('上游缺失 Content-Type 仍识别推理流并登记真实用量和加密归属', async t => {
  const f = await fixture(t, async () => new Response(Buffer.from(completed('no-header', [{ type: 'reasoning', encrypted_content: 'no-header-owner' }]))));
  const r = await f.send(); assert.match(r.headers.get('content-type'), /text\/event-stream/);
  await r.text(); assert.equal(f.store.data.routed, 1); assert.equal(f.router.scheduler.load('a'), 90);
  assert.equal(f.router.scheduler.owner({ input: [{ encrypted_content: 'no-header-owner' }] }), 'a');
});
test('HTTP 请求实际按官方额度路由，耗尽后换用另一个未绑定账号', async t => {
  const calls = [];
  const f = await fixture(t, async (_url, options) => {
    calls.push(options.headers.authorization);
    return new Response(completed(String(calls.length)), { headers: { 'content-type': 'text/event-stream' } });
  });
  for (const slot of ['a', 'b']) Object.assign(f.store.data.accounts[slot], { subject: slot, clientId: `client-${slot}` });
  const snapshot = (slot, five, weekly) => ({ slot, source: 'official_isolated_codex_usage', registration: hash(`${slot}:client-${slot}`), updatedAt: Date.now(), fiveHour: { remainingPercent: five, resetsAt: Date.now() + 5 * 3600_000 }, weekly: { remainingPercent: weekly, resetsAt: Date.now() + 168 * 3600_000 } });
  await writeFile(join(f.store.dir, 'quota-cache-a.json'), JSON.stringify(snapshot('a', 90, 10)));
  await writeFile(join(f.store.dir, 'quota-cache-b.json'), JSON.stringify(snapshot('b', 50, 95)));
  await (await f.send()).text(); assert.equal(calls[0], 'Bearer token-b');
  await writeFile(join(f.store.dir, 'quota-cache-b.json'), JSON.stringify(snapshot('b', 0, 95)));
  await (await f.send()).text(); assert.equal(calls[1], 'Bearer token-a');
  const state = await (await fetch(`${f.base}/admin/status`, { headers: { 'x-router-key': f.store.data.adminKey } })).json();
  assert.equal(state.allocation.mode, 'official_quota_with_reset_v1'); assert.equal(state.allocation.nextUnboundAccount, 'a');
  f.store.data.accounts.c = { ...f.store.data.accounts.a, subject: 'c', clientId: 'client-c', accessToken: 'token-c' };
  await writeFile(join(f.store.dir, 'quota-cache-c.json'), JSON.stringify(snapshot('c', 85, 90)));
  assert.match(await (await f.send()).text(), /response.completed/);
  assert.equal(calls[2], 'Bearer token-c');
  const admin = { 'x-router-key': f.store.data.adminKey, 'content-type': 'application/json' };
  const primary = await fetch(`${f.base}/admin/primary`, { method: 'POST', headers: admin, body: JSON.stringify({ slot: 'c' }) });
  assert.equal(primary.status, 200);
  const updated = await (await fetch(`${f.base}/admin/status`, { headers: admin })).json();
  assert.equal(updated.primarySlot, 'c');
  assert.equal(updated.accounts.find(account => account.slot === 'c').allocationQuota.fiveHour.remainingPercent, 85);
});
