import { randomBytes, randomUUID, createHash, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { allocationQuota, quotaPriority, readAllocationCaches } from './allocation.mjs';

export const APP = 'Codex Plan Router';
export const ISSUER = 'https://auth.openai.com';
export const API = 'https://api.openai.com/v1';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const WINDOW = 5 * 3600_000;
const PRIMARY_RESERVE_PERCENT = 1;
export const isAccountSlot = slot => typeof slot === 'string' && /^[a-z]{1,8}$/.test(slot) && slot !== 'primary' && slot !== 'none';
export const accountSlots = accounts => [...new Set(['a', 'b', ...Object.keys(accounts).filter(isAccountSlot)])]
  .sort((a, b) => a.length - b.length || a.localeCompare(b, 'en'));

function nextAccountSlot(accounts) {
  for (let index = 1; ; index++) {
    let slot = '';
    for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) {
      slot = String.fromCharCode(97 + (n - 1) % 26) + slot;
    }
    if (isAccountSlot(slot) && !Object.hasOwn(accounts, slot)) return slot;
  }
}
export const secret = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class RouterError extends Error {
  constructor(message, status = 400, code = 'router_error') { super(message); this.status = status; this.code = code; }
}
export async function atomicJSON(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
  await chmod(path, 0o600);
}
export class Store {
  constructor(dir) { this.dir = dir; this.queue = Promise.resolve(); }
  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    this.path = join(this.dir, 'state.json');
    try { this.data = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.data = { version: 1, hostId: `urn:uuid:${randomUUID()}`, bridgeKey: secret(), adminKey: secret(), accounts: {}, usage: [], opaque: {}, fallbacks: 0, routed: 0 };
      await this.save();
    }
    if (this.data.version !== 1) throw new Error('不支持的状态文件版本');
    return this;
  }
  save() {
    const snapshot = structuredClone(this.data);
    this.queue = this.queue.catch(() => {}).then(() => atomicJSON(this.path, snapshot));
    return this.queue;
  }
}

export function decodeJWT(token) {
  const parts = token?.split('.');
  if (parts?.length !== 3) throw new RouterError('登录返回的身份令牌格式无效');
  try { return { header: JSON.parse(Buffer.from(parts[0], 'base64url')), claims: JSON.parse(Buffer.from(parts[1], 'base64url')), signed: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], 'base64url') }; }
  catch { throw new RouterError('登录返回的身份令牌无法解析'); }
}
export function validateIDToken(token, { clientId, nonce, jwks, now = Date.now() }) {
  const jwt = decodeJWT(token);
  if (jwt.header.alg !== 'RS256') throw new RouterError('身份令牌签名算法无效');
  const key = jwks.keys?.find(k => k.kid === jwt.header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
  if (!key || !verify('RSA-SHA256', Buffer.from(jwt.signed), createPublicKey({ key, format: 'jwk' }), jwt.signature)) throw new RouterError('身份令牌签名验证失败');
  const c = jwt.claims, audiences = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== ISSUER || !audiences.includes(clientId) || (audiences.length > 1 && c.azp !== clientId) || (c.azp && c.azp !== clientId) || typeof c.sub !== 'string' || !c.sub || !Number.isFinite(c.exp) || c.exp * 1000 <= now || (c.nbf && c.nbf * 1000 > now + 30_000) || !equal(c.nonce, nonce)) throw new RouterError('身份令牌的账号、有效期或登录事务验证失败');
  return c;
}
export async function officialFetch(url, options = {}) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !['auth.openai.com', 'api.openai.com', 'chatgpt.com'].includes(u.hostname) || u.port || u.username || u.password) throw new RouterError('拒绝访问非官方上游地址');
  return fetch(u, { ...options, redirect: 'manual', signal: options.signal ?? AbortSignal.timeout(30_000) });
}
async function jsonResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof data.error === 'string' ? data.error : data.error?.code;
    throw new RouterError(`授权服务返回 ${response.status}${code && /^[a-z_]+$/.test(code) ? `（${code}）` : ''}`, response.status, code || 'oauth_error');
  }
  return data;
}
export class Auth {
  constructor(store, port, fetcher = officialFetch) { this.store = store; this.port = port; this.fetch = fetcher; this.pending = new Map(); this.refreshes = new Map(); }
  async discovery() {
    if (!this.metadata) {
      const d = await jsonResponse(await this.fetch(`${ISSUER}/.well-known/openid-configuration`));
      if (d.issuer !== ISSUER) throw new RouterError('OAuth 发行方无效');
      for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) {
        if (!d[key] || new URL(d[key]).origin !== ISSUER) throw new RouterError('OAuth 服务地址无效');
      }
      this.metadata = d;
    }
    return this.metadata;
  }
  async begin(slot) {
    const accounts = this.store.data.accounts;
    if (slot !== null && (!isAccountSlot(slot) || (!['a', 'b'].includes(slot) && !Object.hasOwn(accounts, slot)))) throw new RouterError('账号位置无效');
    for (const [key, p] of this.pending) if (p.expires < Date.now() || p.slot === slot) this.pending.delete(key);
    const d = await this.discovery(), existing = this.store.data.accounts[slot];
    const p = { slot, state: secret(), nonce: secret(), verifier: secret(), expires: Date.now() + 600_000, clientId: existing?.clientId, subject: existing?.subject, redirect: `http://127.0.0.1:${this.port}/auth/callback` };
    const url = new URL(d.authorization_endpoint);
    const params = { client_id: p.clientId ?? 'dynamic_agent_client', ext_agent_host_id: this.store.data.hostId, response_type: 'code', redirect_uri: p.redirect, scope: SCOPES, resource: API, state: p.state, nonce: p.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(p.verifier).digest('base64url') };
    if (!p.clientId) params.agent_name_hint = APP;
    if (existing?.idToken) params.id_token_hint = existing.idToken;
    if (existing?.email) params.login_hint = existing.email;
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    this.pending.set(p.state, p);
    return url.toString();
  }
  async callback(params) {
    const state = params.get('state'), p = this.pending.get(state);
    if (!p || p.expires < Date.now() || !equal(state, p.state)) throw new RouterError('登录事务已过期或校验失败，请重新登录');
    this.pending.delete(state);
    if (params.has('error')) throw new RouterError('登录或订阅授权未完成，可以重新尝试');
    const suppliedClient = params.get('client_id');
    if (p.clientId && suppliedClient && suppliedClient !== p.clientId) throw new RouterError('返回的客户端注册与所选账号不一致');
    const clientId = p.clientId ?? suppliedClient;
    if (!clientId || clientId === 'dynamic_agent_client' || !params.get('code')) throw new RouterError('登录未返回完整的账号注册信息');
    const d = await this.discovery();
    const data = await jsonResponse(await this.fetch(d.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code: params.get('code'), code_verifier: p.verifier, redirect_uri: p.redirect, resource: API }) }));
    const jwks = await jsonResponse(await this.fetch(d.jwks_uri));
    const identity = validateIDToken(data.id_token, { clientId, nonce: p.nonce, jwks });
    if (p.subject && identity.sub !== p.subject) throw new RouterError('登录账号与所选已保存账号不一致');
    const accounts = this.store.data.accounts;
    const slot = p.slot ?? nextAccountSlot(accounts);
    if (p.slot !== null && accounts[slot] && !p.subject) throw new RouterError('此账号位置刚完成了授权，请返回设置重试');
    const email = typeof identity.email === 'string' ? identity.email : '';
    if (Object.entries(accounts).some(([key, other]) => key !== slot && (
      other.subject === identity.sub || (email && other.email?.toLowerCase() === email.toLowerCase())
    ))) throw new RouterError('不能重复连接同一个个人账号，请在浏览器选择其他账号');
    const account = { clientId, subject: identity.sub, email: identity.email ?? '', idToken: data.id_token, verified: false, cooldownUntil: 0, needsLogin: false };
    this.applyTokens(account, data);
    accounts[slot] = account;
    await this.store.save();
    return slot;
  }
  applyTokens(account, data) {
    if (typeof data.access_token !== 'string' || !data.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || (data.token_type ?? '').toLowerCase() !== 'bearer') throw new RouterError('授权服务返回的访问令牌无效');
    const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/) : account.scopes;
    account.accessToken = data.access_token;
    account.refreshToken = data.refresh_token ?? account.refreshToken;
    account.scopes = scopes ?? [];
    account.enabled = account.scopes.includes('chatgpt.tokens.use.direct');
    account.expiresAt = Date.now() + data.expires_in * 1000;
    account.needsLogin = false;
  }
  async token(slot) {
    const a = this.store.data.accounts[slot];
    if (!a?.enabled || a.needsLogin) throw new RouterError('此账号尚未授权使用订阅额度，请重新授权', 401, 'account_unavailable');
    if (a.expiresAt > Date.now() + 120_000) return a.accessToken;
    if (!this.refreshes.has(slot)) this.refreshes.set(slot, this.refresh(slot).finally(() => this.refreshes.delete(slot)));
    await this.refreshes.get(slot);
    return this.store.data.accounts[slot].accessToken;
  }
  async refresh(slot) {
    const a = this.store.data.accounts[slot];
    if (!a.refreshToken) throw new RouterError('此账号需要重新登录', 401, 'account_unavailable');
    try {
      const d = await this.discovery();
      const data = await jsonResponse(await this.fetch(d.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: a.clientId, refresh_token: a.refreshToken, resource: API }) }));
      this.applyTokens(a, data);
      await this.store.save();
    } catch (e) {
      if (['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(e.code)) {
        delete a.accessToken; delete a.refreshToken; delete a.idToken;
        a.needsLogin = true; a.verified = false;
        await this.store.save();
      }
      throw e;
    }
  }
  async disconnect(slot) {
    if (!isAccountSlot(slot) || !Object.hasOwn(this.store.data.accounts, slot)) throw new RouterError('账号位置无效');
    if (this.refreshes.has(slot)) await this.refreshes.get(slot).catch(() => {});
    const a = this.store.data.accounts[slot];
    if (!a) return;
    if (a.refreshToken) {
      const d = await this.discovery();
      const r = await this.fetch(d.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: a.refreshToken, token_type_hint: 'refresh_token', client_id: a.clientId }) });
      if (!r.ok) throw new RouterError('远端撤销未确认，保留本地授权以便重试', 502);
    }
    for (const key of ['accessToken', 'refreshToken', 'idToken']) delete a[key];
    a.enabled = false; a.verified = false; a.needsLogin = true;
    await this.store.save();
  }
}

export function opaqueValues(value, found = []) {
  if (Array.isArray(value)) for (const item of value) opaqueValues(item, found);
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (key === 'encrypted_content' && typeof child === 'string' && child) found.push(hash(child));
    else if (child && typeof child === 'object') opaqueValues(child, found);
  }
  return found;
}
const UNSUPPORTED = new Set(['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id']);
const ALLOWED_TOOLS = new Set(['namespace', 'function', 'custom', 'web_search', 'web_search_preview']);
export function compatible(body) {
  if (!body || !Array.isArray(body.input) || body.store === true || body.stream === false) return false;
  if (Object.entries(body).some(([k, v]) => UNSUPPORTED.has(k) && v !== null && v !== undefined)) return false;
  const toolsOK = tools => Array.isArray(tools) && tools.every(t => t && ALLOWED_TOOLS.has(t.type) && (t.type !== 'namespace' || toolsOK(t.tools)));
  if (body.tools && !toolsOK(body.tools)) return false;
  if (body.input.some(i => i.role === 'system' || i.type === 'item_reference' || i.type === 'tool_search_call' || i.type === 'tool_search_output' || (i.type === 'additional_tools' && !toolsOK(i.tools)))) return false;
  return true;
}
export class Scheduler {
  constructor(store, now = () => Date.now()) { this.store = store; this.now = now; this.inFlight = Object.assign(Object.create(null), { a: 0, b: 0 }); this.completed = new Set(); this.quotas = {}; this.lastDecision = null; }
  load(slot) {
    const now = this.now();
    return this.store.data.usage.filter(x => x.slot === slot && x.at > now - WINDOW).reduce((n, x) => n + x.input + 4 * x.output, 0) + (this.inFlight[slot] ?? 0) * 4096;
  }
  eligible(slot) {
    const a = this.store.data.accounts[slot];
    return !!(a?.enabled && a.verified && !a.needsLogin && !(a.cooldownUntil > this.now()));
  }
  owner(body) {
    const hashes = opaqueValues(body.input), owners = new Set();
    for (const h of hashes) owners.add(this.store.data.opaque[h]?.slot ?? 'primary');
    if (owners.size > 1) throw new RouterError('上下文含有来自不同账号的加密内容，已停止发送以保护会话', 409, 'context_owner_conflict');
    return [...owners][0] ?? null;
  }
  select(body, excluded = new Set(), { ignoreContextOwner = false } = {}) {
    const owner = ignoreContextOwner ? null : this.owner(body);
    if (owner === 'primary') return 'primary';
    if (owner) {
      if (excluded.has(owner) || !this.eligible(owner) || this.officialQuota(owner)?.exhausted) throw new RouterError('当前上下文所属账号暂不可用或额度已耗尽，保留会话并等待恢复', 429, 'context_account_unavailable');
      this.lastDecision = { slot: owner, basis: 'context_owner' };
      return owner;
    }
    let candidates = accountSlots(this.store.data.accounts).filter(slot => this.eligible(slot) && !excluded.has(slot) && !this.officialQuota(slot)?.exhausted);
    const primarySlot = this.store.data.primarySlot;
    const primaryQuota = this.officialQuota(primarySlot);
    if ([primaryQuota?.fiveHour, primaryQuota?.weekly].some(window => window && window.remainingPercent <= PRIMARY_RESERVE_PERCENT)) {
      candidates = candidates.filter(slot => slot !== primarySlot);
    }
    const official = candidates.length > 0 && candidates.every(slot => this.officialQuota(slot)?.complete);
    if (official) {
      const now = this.now();
      const priorities = new Map(candidates.map(slot => [slot, quotaPriority(this.officialQuota(slot), this.inFlight[slot], now)]));
      const highest = priorities.values().reduce((best, score) => Math.max(best, score), -Infinity);
      // 与最高分相差三分以内时，使用本地用量和轮转顺序。
      candidates = candidates.filter(slot => highest - priorities.get(slot) <= 3);
    }
    candidates.sort((a, b) => this.load(a) - this.load(b) ||
      (this.store.data.accounts[a].lastUsed ?? 0) - (this.store.data.accounts[b].lastUsed ?? 0));
    this.lastDecision = { slot: candidates[0] ?? null, basis: official ? 'official_quota' : 'observed_usage_fallback', ...(ignoreContextOwner ? { sessionOverride: true } : {}) };
    return candidates[0] ?? null;
  }
  async observe(slot, event) {
    if (event.type === 'response.failed') {
      const code = event.response?.error?.code;
      if (code === 'subscription_sharing_usage_limit_exceeded' && slot !== 'primary') this.pause(slot, 15 * 60_000, code);
    }
    const outputs = event.type === 'response.output_item.done' ? [event.item] : event.response?.output;
    for (const value of opaqueValues(outputs)) this.store.data.opaque[value] = { slot, at: this.now() };
    if (event.type === 'response.completed') {
      const id = event.response?.id;
      if (id && this.completed.has(id)) return;
      if (id) { this.completed.add(id); if (this.completed.size > 2000) this.completed.delete(this.completed.values().next().value); }
      const usageSlot = slot === 'primary' ? this.store.data.primarySlot : slot;
      if (usageSlot && Object.hasOwn(this.store.data.accounts, usageSlot)) {
        const u = event.response?.usage ?? {};
        this.store.data.usage.push({ slot: usageSlot, at: this.now(), input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0 });
      }
      if (slot !== 'primary') this.store.data.routed++;
    }
    this.store.data.usage = this.store.data.usage.filter(x => x.at > this.now() - WINDOW);
    if (outputs || event.type === 'response.completed' || event.type === 'response.failed') await this.store.save();
  }
  pause(slot, duration, reason) {
    const a = this.store.data.accounts[slot];
    if (a) { a.cooldownUntil = this.now() + duration; a.pauseReason = reason; }
  }
  status() {
    return accountSlots(this.store.data.accounts).map(slot => {
      const a = this.store.data.accounts[slot];
      const quota = this.officialQuota(slot);
      return { slot, email: a?.email ?? '', registered: !!a, enabled: !!a?.enabled, verified: !!a?.verified, needsLogin: !!a?.needsLogin, cooldownUntil: a?.cooldownUntil ?? 0, observedScore: this.load(slot), inFlight: this.inFlight[slot] ?? 0, allocationQuota: quota, allocationPriority: quotaPriority(quota, this.inFlight[slot], this.now()) };
    });
  }
  officialQuota(slot) {
    return allocationQuota(this.quotas[slot], slot, this.store.data.accounts[slot], this.now());
  }
  async refreshQuotas() {
    if (this.quotaReading) return this.quotaReading;
    this.quotaReading = readAllocationCaches(this.store.dir, this.store.data.accounts, this.now()).then(result => { this.quotas = result; }).finally(() => { this.quotaReading = null; });
    return this.quotaReading;
  }
  allocationStatus() {
    const previous = this.lastDecision;
    const nextUnboundAccount = this.select({ input: [] });
    const nextBasis = this.lastDecision?.basis;
    this.lastDecision = previous;
    return { mode: 'official_quota_with_reset_v1', freshWindowSeconds: 180, nextUnboundAccount, nextBasis, lastDecision: previous };
  }
}

export class SSEObserver {
  constructor(callback) { this.callback = callback; this.buffer = ''; this.decoder = new TextDecoder(); this.completed = false; this.failed = false; this.limit = 16 * 1024 * 1024; }
  async push(chunk) {
    this.buffer = (this.buffer + this.decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let end;
    while ((end = this.buffer.indexOf('\n\n')) >= 0) {
      const block = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 2);
      const data = block.split('\n').filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') {
        let event; try { event = JSON.parse(data); } catch { continue; }
        if (event.type === 'response.completed') this.completed = true;
        if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) this.failed = true;
        await this.callback(event);
      }
    }
    if (this.buffer.length > this.limit) throw new RouterError('上游事件超过允许大小', 502);
  }
}
