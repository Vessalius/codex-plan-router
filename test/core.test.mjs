import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Store, Scheduler, Auth, SSEObserver, compatible, validateIDToken, opaqueValues, ISSUER, WINDOW } from '../core.mjs';
import { DesktopConfig, localProxyEnvironment } from '../config.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'plan-router-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new Store(dir).init();
}
const body = { model: 'test-model', input: [{ role: 'user', content: '你好' }], store: false, stream: true };
function addAccounts(store) {
  for (const slot of ['a', 'b']) store.data.accounts[slot] = { enabled: true, verified: true, subject: slot, clientId: `client-${slot}`, accessToken: `access-${slot}`, refreshToken: `refresh-${slot}`, expiresAt: Date.now() + 3600_000, scopes: ['chatgpt.tokens.use.direct'] };
}
test('持久化凭证使用受保护权限，主机和管理密钥重启后保持稳定', async t => {
  const store = await fixture(t), second = await new Store(store.dir).init();
  assert.equal(second.data.hostId, store.data.hostId);
  assert.equal(second.data.adminKey, store.data.adminKey);
  if (process.platform !== 'win32') {
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    assert.equal((await stat(store.dir)).mode & 0o777, 0o700);
  }
});
test('调度按五小时观察用量和并发分配，窗口外数据不影响选择', async t => {
  const store = await fixture(t); addAccounts(store);
  let now = Date.now(); const s = new Scheduler(store, () => now);
  assert.equal(s.select(body), 'a'); s.inFlight.a++;
  assert.equal(s.select(body), 'b'); s.inFlight.a--;
  await s.observe('a', { type: 'response.completed', response: { id: 'one', usage: { input_tokens: 50, output_tokens: 100 } } });
  assert.equal(s.load('a'), 450); assert.equal(s.select(body), 'b');
  await s.observe('a', { type: 'response.completed', response: { id: 'one', usage: { input_tokens: 50, output_tokens: 100 } } });
  assert.equal(s.load('a'), 450);
  s.pause('b', 1000, 'test'); assert.equal(s.select(body), 'a');
  now += WINDOW + 1; assert.equal(s.load('a'), 0);
});
test('加密上下文不能跨账号，未知历史留主号，混合归属明确报错', async t => {
  const store = await fixture(t); addAccounts(store); const s = new Scheduler(store);
  const bound = { ...body, input: [{ type: 'reasoning', encrypted_content: 'encrypted-a' }] };
  assert.equal(s.select(bound), 'primary');
  await s.observe('a', { type: 'response.output_item.done', item: { type: 'reasoning', encrypted_content: 'encrypted-a' } });
  assert.equal(s.select(bound), 'a');
  assert.equal(JSON.stringify(store.data).includes('encrypted-a'), false);
  s.pause('a', 1000, 'test'); assert.throws(() => s.select(bound), /所属账号暂不可用/);
  const mixed = { ...bound, input: [...bound.input, { encrypted_content: 'unknown' }] };
  assert.throws(() => s.select(mixed), /不同账号/);
  assert.equal(opaqueValues(bound).length, 1);
});
test('不删减不支持的工具、历史或参数来假装兼容', () => {
  assert.equal(compatible(body), true);
  for (const change of [{ tools: [{ type: 'tool_search' }] }, { previous_response_id: 'old' }, { temperature: 0.4 }, { input: [{ role: 'system', content: 'x' }] }, { input: [{ type: 'item_reference', id: 'old' }] }]) assert.equal(compatible({ ...body, ...change }), false);
  assert.equal(compatible({ ...body, tools: [{ type: 'namespace', name: 'test', tools: [{ type: 'function', name: 'x', parameters: {} }] }] }), true);
});
test('分片 UTF-8 与跨块 CRLF 的 SSE 仍完整识别终止事件', async () => {
  const events = [], observer = new SSEObserver(e => events.push(e));
  const bytes = Buffer.from('data: {"type":"response.output_text.delta","delta":"你好"}\r\n\r\ndata: {"type":"response.completed","response":{"id":"ok"}}\r\n\r\n');
  for (const b of bytes) await observer.push(Uint8Array.of(b));
  assert.equal(events.length, 2); assert.equal(events[0].delta, '你好'); assert.equal(observer.completed, true);
});
test('OIDC 拒绝伪造签名、错误账号受众、过期和事务错配', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { ...publicKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' };
  const claims = { iss: ISSUER, aud: 'client', sub: 'user', nonce: 'nonce', exp: Math.floor(Date.now() / 1000) + 120 };
  const token = values => { const content = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url')}.${Buffer.from(JSON.stringify(values)).toString('base64url')}`; return `${content}.${sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url')}`; };
  const opts = { clientId: 'client', nonce: 'nonce', jwks: { keys: [key] } };
  assert.equal(validateIDToken(token(claims), opts).sub, 'user');
  for (const changes of [{ nonce: 'other' }, { aud: 'other' }, { exp: 1 }, { iss: 'https://evil.example' }, { aud: ['client', 'other'] }]) assert.throws(() => validateIDToken(token({ ...claims, ...changes }), opts));
  const valid = token(claims), parts = valid.split('.');
  parts[2] = Buffer.alloc(256).toString('base64url'); assert.throws(() => validateIDToken(parts.join('.'), opts));
});
test('OAuth 每个账号使用单独注册，保持稳定主机 ID 并校验 state', async t => {
  const store = await fixture(t);
  const auth = new Auth(store, 12345, async () => Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/api/accounts/authorize`, token_endpoint: `${ISSUER}/api/accounts/oauth/token`, jwks_uri: `${ISSUER}/.well-known/jwks.json`, revocation_endpoint: `${ISSUER}/revoke` }));
  const a = new URL(await auth.begin('a')), b = new URL(await auth.begin('b'));
  assert.equal(a.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(a.searchParams.get('ext_agent_host_id'), b.searchParams.get('ext_agent_host_id'));
  assert.notEqual(a.searchParams.get('state'), b.searchParams.get('state'));
  assert.equal(a.searchParams.get('redirect_uri'), 'http://127.0.0.1:12345/auth/callback');
  await assert.rejects(auth.callback(new URLSearchParams({ state: 'invalid', code: 'x' })), /校验失败/);
});
test('并发刷新只消费一次轮换令牌，临时网络故障不删授权', async t => {
  const store = await fixture(t); addAccounts(store); store.data.accounts.a.expiresAt = 0;
  let calls = 0;
  const auth = new Auth(store, 12345, async (_url, options) => {
    if (!options) return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`, revocation_endpoint: `${ISSUER}/revoke` });
    calls++; await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(options.body.get('client_id'), 'client-a');
    return Response.json({ access_token: 'new', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 3600 });
  });
  assert.deepEqual(await Promise.all([auth.token('a'), auth.token('a'), auth.token('a')]), ['new', 'new', 'new']);
  assert.equal(calls, 1); assert.equal(store.data.accounts.a.refreshToken, 'rotated');
  store.data.accounts.a.expiresAt = 0; auth.fetch = async () => { throw new Error('temporary'); };
  await assert.rejects(auth.token('a'));
  assert.equal(store.data.accounts.a.refreshToken, 'rotated');
});
test('完整 OAuth 回调验证签名后才保存，并拒绝第二个位置重复登录同一账号', async t => {
  const store = await fixture(t);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'one', alg: 'RS256' }] };
  let subject = 'same-user', email = 'test@example.invalid';
  let nonce;
  const auth = new Auth(store, 12345, async (url, opts) => {
    if (url.endsWith('openid-configuration')) return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`, revocation_endpoint: `${ISSUER}/revoke` });
    if (url.endsWith('/jwks')) return Response.json(jwks);
    assert.notEqual(opts.body.get('client_id'), 'dynamic_agent_client');
    const content = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'one' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: ISSUER, aud: opts.body.get('client_id'), sub: subject, email, nonce, exp: Math.floor(Date.now() / 1000) + 120 })).toString('base64url')}`;
    return Response.json({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct', id_token: `${content}.${sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url')}` });
  });
  const a = new URL(await auth.begin('a')); nonce = a.searchParams.get('nonce');
  await auth.callback(new URLSearchParams({ state: a.searchParams.get('state'), code: 'one', client_id: 'issued-a' }));
  assert.equal(store.data.accounts.a.subject, 'same-user'); assert.equal(store.data.accounts.a.enabled, true); assert.equal(store.data.accounts.a.verified, false);
  const b = new URL(await auth.begin('b')); nonce = b.searchParams.get('nonce');
  await assert.rejects(auth.callback(new URLSearchParams({ state: b.searchParams.get('state'), code: 'two', client_id: 'issued-b' })), /同一个个人账号/);
  assert.equal(store.data.accounts.b, undefined); assert.equal(store.data.accounts.a.clientId, 'issued-a');
  for (const expected of ['b', 'c', 'd']) {
    subject = `user-${expected}`;
    email = `${expected}@example.invalid`;
    const add = new URL(await auth.begin(null));
    nonce = add.searchParams.get('nonce');
    const slot = await auth.callback(new URLSearchParams({ state: add.searchParams.get('state'), code: 'new', client_id: `issued-${expected}` }));
    assert.equal(slot, expected);
  }
  const reopened = await new Store(store.dir).init();
  assert.deepEqual(Object.keys(reopened.data.accounts), ['a', 'b', 'c', 'd']);
  assert.equal(reopened.data.accounts.a.clientId, 'issued-a');
  const reauthorize = new URL(await auth.begin('c'));
  assert.equal(reauthorize.searchParams.get('client_id'), 'issued-c');
});
test('启用配置保留主号和提供商 ID，撤回不覆盖其他配置改动', async t => {
  const store = await fixture(t); addAccounts(store);
  const path = join(store.dir, 'desktop.toml'), c = new DesktopConfig(store, 12345, path);
  await c.write('model = "gpt-6.1-sol"\n[features]\nmemories = true\n');
  const before = await readFile(path, 'utf8'); await c.enable();
  let text = await readFile(path, 'utf8');
  assert.match(text, /openai_base_url = "http:\/\/127.0.0.1:12345/); assert.equal(text.includes('[model_providers.openai]'), false);
  assert.equal(text.includes('model_provider ='), false);
  await c.write(text + '\n[extra]\nkeep = true\n'); await c.disable();
  text = await readFile(path, 'utf8'); assert.ok(text.includes(before)); assert.match(text, /keep = true/); assert.equal(text.includes('bridge/'), false);
});
test('已有模型提供商配置时拒绝自动覆盖', async t => {
  const store = await fixture(t); addAccounts(store); const c = new DesktopConfig(store, 12345, join(store.dir, 'desktop.toml'));
  await c.write('[model_providers.openai]\nname = "OpenAI"\nbase_url = "https://example.invalid"\n');
  await assert.rejects(c.enable(), /未自动覆盖/);
});
test('自启动网络配置只允许无凭据的本机代理，拒绝保存其他环境', () => {
  const result = localProxyEnvironment({ HTTP_PROXY: 'http://127.0.0.1:7890', SECRET: 'never-save', NO_PROXY: 'internal.invalid' });
  assert.equal(result.HTTP_PROXY, 'http://127.0.0.1:7890'); assert.equal(result.SECRET, undefined); assert.equal(result.NO_PROXY.includes('internal.invalid'), false);
  for (const HTTP_PROXY of ['http://user:password@127.0.0.1:7890', 'http://remote.example:7890', 'http://127.0.0.1:7890/?token=secret', 'socks5://127.0.0.1:7890', 'invalid']) assert.throws(() => localProxyEnvironment({ HTTP_PROXY }));
});
