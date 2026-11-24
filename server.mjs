import http from 'node:http';
import { once } from 'node:events';
import { gunzipSync, inflateSync, brotliDecompressSync, zstdDecompressSync } from 'node:zlib';
import { Auth, Scheduler, SSEObserver, RouterError, API, APP, compatible, equal, isAccountSlot, officialFetch } from './core.mjs';
import { DesktopConfig } from './config.mjs';
import { HTML } from './ui.mjs';
import { bilingual, languageFrom, localizeMessage } from './i18n.mjs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { QUOTA_QUERY_CONCURRENCY } from './quota.mjs';

const MAX_BODY = 64 * 1024 * 1024;
const PRIMARY = 'https://chatgpt.com';
function reply(res, status, value, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
  res.end(typeof value === 'string' ? value : JSON.stringify(value));
}
function requestLanguage(req) {
  return languageFrom(req.headers['accept-language'], 'en');
}
function authPage(language, title, message) {
  const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<!doctype html><html lang="${language === 'zh' ? 'zh-CN' : 'en'}"><meta charset="utf-8"><title>${escape(title)}</title><p>${escape(message)}</p></html>`;
}
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new RouterError('请求体过大', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
export function parseBody(raw, encoding) {
  const options = { maxOutputLength: MAX_BODY };
  if (encoding === 'gzip') raw = gunzipSync(raw, options);
  else if (encoding === 'deflate') raw = inflateSync(raw, options);
  else if (encoding === 'br') raw = brotliDecompressSync(raw, options);
  else if (encoding === 'zstd') raw = zstdDecompressSync(raw, options);
  else if (encoding && encoding !== 'identity') throw new RouterError('不支持的请求压缩格式', 415);
  try { return JSON.parse(raw); } catch { throw new RouterError('请求不是有效 JSON'); }
}
function responseHeaders(upstream) {
  const h = {};
  for (const name of ['content-type', 'x-request-id', 'retry-after']) if (upstream.headers.has(name)) h[name] = upstream.headers.get(name);
  h['cache-control'] = 'no-store'; h['x-accel-buffering'] = 'no';
  return h;
}
export class RouterServer {
  constructor(store, { port = 47631, fetcher = officialFetch, configPath } = {}) {
    this.store = store; this.port = port; this.fetch = fetcher;
    this.auth = new Auth(store, port, fetcher); this.scheduler = new Scheduler(store);
    this.config = new DesktopConfig(store, port, configPath); this.jobs = new Set(); this.verifying = new Set();
    this.activeRequests = 0;
    this.server = http.createServer((req, res) => {
      this.activeRequests++;
      let counted = true;
      const finished = () => { if (counted) { counted = false; this.activeRequests--; } };
      res.once('finish', finished); res.once('close', finished);
      this.handle(req, res).catch(e => {
        if (!res.headersSent) reply(res, e.status || 502, { error: { code: e.code || 'router_failure', message: localizeMessage(e instanceof RouterError ? e.message : '本地代理请求失败；未重放已经开始的请求', requestLanguage(req)) } });
        else if (!res.destroyed) { res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { code: 'router_stream_interrupted', message: localizeMessage('代理流中断，请检查连接；没有自动重放请求', requestLanguage(req)) } })}\n\n`); res.end(); }
      });
    });
    this.server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
    this.server.requestTimeout = 0; this.server.headersTimeout = 15_000;
  }
  async listen() { this.server.listen(this.port, '127.0.0.1'); await once(this.server, 'listening'); return this; }
  async close() { clearInterval(this.quotaTimer); await new Promise(resolve => this.server.close(resolve)); if (this.quotaProcess) this.quotaProcess.kill('SIGTERM'); }
  async status() { await this.scheduler.refreshQuotas(); return { app: APP, accounts: this.scheduler.status(), primarySlot: this.store.data.primarySlot ?? '', routed: this.store.data.routed, fallbacks: this.store.data.fallbacks, observedOnly: false, allocation: this.scheduler.allocationStatus(), sessionOverride: this.store.data.sessionOverride ?? null, activeRequests: Math.max(0, this.activeRequests - 1), desktop: await this.config.status() }; }
  async handle(req, res) {
    const allowedHost = `127.0.0.1:${this.port}`;
    if (req.headers.host !== allowedHost) throw new RouterError('拒绝不匹配的本地地址', 403);
    const url = new URL(req.url, `http://${allowedHost}`);
    if (url.pathname === '/auth/callback' && req.method === 'GET') {
      const language = requestLanguage(req);
      try {
        await this.auth.callback(url.searchParams);
        const title = bilingual(language, '授权完成', 'Authorization complete');
        const message = bilingual(language, '账号授权已保存。请关闭此页，返回本地设置。', 'Account authorization saved. Close this tab and return to Settings.');
        reply(res, 200, authPage(language, title, message), 'text/html; charset=utf-8');
      } catch (e) {
        const title = bilingual(language, '授权未完成', 'Authorization incomplete');
        const message = localizeMessage(e instanceof RouterError ? e.message : '授权服务暂不可用，请返回设置页重试', language);
        reply(res, 400, authPage(language, title, message), 'text/html; charset=utf-8');
      }
      return;
    }
    if (req.headers.origin && req.headers.origin !== `http://${allowedHost}`) throw new RouterError('拒绝跨站请求', 403);
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new RouterError('拒绝跨站请求', 403);
    if (url.pathname === '/health' && req.method === 'GET') return reply(res, 200, { ok: true, app: APP });
    if (url.pathname === '/' && req.method === 'GET') return reply(res, 200, HTML, 'text/html; charset=utf-8');
    if (url.pathname.startsWith('/admin/')) {
      if (!equal(req.headers['x-router-key'], this.store.data.adminKey)) throw new RouterError('请从安装时提供的设置链接进入', 401);
      if (url.pathname === '/admin/status' && req.method === 'GET') return reply(res, 200, await this.status());
      if (req.method !== 'POST') throw new RouterError('方法不允许', 405);
      const body = parseBody(await readBody(req));
      if (url.pathname === '/admin/shutdown' && this.shutdown) {
        if (this.activeRequests > 1) throw new RouterError('请等待当前任务结束后再停止后台', 409);
        if (body.restore === true) await this.config.disable();
        res.once('finish', () => void this.shutdown());
        return reply(res, 200, { ok: true });
      }
      if (url.pathname === '/admin/login') return reply(res, 200, { url: await this.auth.begin(body.slot === '' ? null : body.slot) });
      if (url.pathname === '/admin/verify') return reply(res, 200, await this.verifyAccount(body.slot));
      if (url.pathname === '/admin/primary') {
        if (body.slot !== '' && (!isAccountSlot(body.slot) || !Object.hasOwn(this.store.data.accounts, body.slot))) throw new RouterError('账号位置无效');
        this.store.data.primarySlot = body.slot || null; await this.store.save();
        return reply(res, 200, { ok: true });
      }
      if (url.pathname === '/admin/session-override') {
        if (typeof body.threadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.threadId)) throw new RouterError('会话 ID 格式无效');
        this.store.data.sessionOverride = { threadId: body.threadId, enabled: true, matches: 0, lastMatchedAt: 0, lastSlot: null };
        await this.store.save();
        return reply(res, 200, { ok: true, enabled: true });
      }
      if (url.pathname === '/admin/disconnect') {
        if (this.scheduler.inFlight[body.slot] || this.verifying.has(body.slot)) throw new RouterError('此账号仍有请求运行，请完成后再断开', 409);
        await this.auth.disconnect(body.slot); return reply(res, 200, { ok: true });
      }
      if (url.pathname === '/admin/enable') { await this.config.enable(); return reply(res, 200, { ok: true, message: localizeMessage('配置已启用。请等所有任务结束后手动退出并重新打开客户端；工具不会主动重启客户端。', requestLanguage(req)) }); }
      if (url.pathname === '/admin/disable') { await this.config.disable(); return reply(res, 200, { ok: true, message: localizeMessage('已移除代理配置。请等任务结束后重新打开客户端生效。后台服务仍在运行，供当前连接收尾。', requestLanguage(req)) }); }
      throw new RouterError('管理接口不存在', 404);
    }
    const prefix = `/bridge/${this.store.data.bridgeKey}`;
    if (!url.pathname.startsWith(`${prefix}/backend-api/codex/`) && !url.pathname.startsWith(`${prefix}/v1/`)) throw new RouterError('接口不存在', 404);
    const relative = url.pathname.slice(prefix.length);
    const path = relative.startsWith('/v1/') ? `/backend-api/codex/${relative.slice(4)}` : relative;
    if (!req.headers.authorization?.startsWith('Bearer ')) throw new RouterError('缺少客户端认证', 401);
    if (!['GET', 'POST'].includes(req.method)) throw new RouterError('方法不允许', 405);
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const raw = req.method === 'POST' ? await readBody(req) : undefined;
    if (path === '/backend-api/codex/responses' && req.method === 'POST') {
      const body = parseBody(raw, req.headers['content-encoding']);
      return this.inference(req, res, body, raw, controller.signal);
    }
    if (path !== '/backend-api/codex/models' && path !== '/backend-api/codex/responses/compact') throw new RouterError('此客户端请求的功能尚未验证，未转发此接口', 501, 'unsupported_desktop_route');
    if (path === '/backend-api/codex/responses/compact' && req.method === 'POST') {
      const owner = this.scheduler.owner(parseBody(raw, req.headers['content-encoding']));
      if (owner && owner !== 'primary') throw new RouterError('当前加密上下文属于代理账号，不能交给主号做远端压缩；未跨账号发送上下文', 400, 'unsupported_bound_compaction');
    }
    return this.primary(req, res, path + url.search, raw, controller.signal);
  }
  async primary(req, res, path, raw, signal) {
    const headers = {};
    for (const key of ['authorization', 'chatgpt-account-id', 'content-type', 'content-encoding', 'accept', 'user-agent', 'originator', 'version', 'session_id', 'conversation_id', 'x-codex-turn-state', 'x-codex-turn-metadata', 'x-codex-parent-thread-id', 'openai-beta', 'x-openai-internal-codex-residency']) if (req.headers[key]) headers[key] = req.headers[key];
    const upstream = await this.fetch(`${PRIMARY}${path}`, { method: req.method, headers, body: raw, signal });
    this.store.data.fallbacks++; await this.store.save();
    return this.pipe(upstream, res, 'primary', { expectSSE: req.method === 'POST' && path.split('?')[0] === '/backend-api/codex/responses' });
  }
  async inference(req, res, body, raw, signal) {
    await this.scheduler.refreshQuotas();
    const configuredThreadId = this.store.data.sessionOverride?.threadId;
    const sessionOverride = !!configuredThreadId && ['session_id', 'conversation_id', 'x-codex-parent-thread-id'].some(key => req.headers[key] === configuredThreadId);
    const primary = () => this.primary(req, res, '/backend-api/codex/responses', raw, signal);
    if (!compatible(body)) {
      // 无法兼容的请求只交还主号，避免删减工具或上下文。
      const owner = this.scheduler.owner(body);
      if (owner && owner !== 'primary') throw new RouterError('当前请求包含此订阅通道不支持的能力，且上下文绑定代理账号；已保留会话，请关闭相关能力后重试', 400, 'unsupported_bound_context');
      return primary();
    }
    if (sessionOverride) {
      const config = this.store.data.sessionOverride;
      config.matches = (config.matches ?? 0) + 1;
      config.lastMatchedAt = Date.now();
    }
    const excluded = new Set();
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      const slot = this.scheduler.select(body, excluded, { ignoreContextOwner: sessionOverride });
      if (sessionOverride) {
        const config = this.store.data.sessionOverride;
        config.lastSlot = slot;
        await this.store.save();
      }
      if (slot === 'primary') return primary();
      if (!slot) {
        if (!Object.values(this.store.data.accounts).some(a => a.verified && a.enabled)) return primary();
        if (lastError) return this.pipe(lastError, res, 'none');
        throw new RouterError('没有可用账号，请在本地设置中检查授权与暂停状态', 429, 'accounts_unavailable');
      }
      excluded.add(slot);
      this.scheduler.inFlight[slot] = (this.scheduler.inFlight[slot] ?? 0) + 1;
      try {
        const token = await this.auth.token(slot);
        this.store.data.accounts[slot].lastUsed = Date.now();
        const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream', 'user-agent': 'codex-plan-router/0.1.0', originator: 'codex_plan_router' };
        const upstream = await this.fetch(`${API}/responses`, { method: 'POST', headers, body: JSON.stringify({ ...body, store: false, stream: true }), signal });
        if (upstream.ok) return await this.pipe(upstream, res, slot, { expectSSE: true });
        const copy = upstream.clone(); let error;
        try { error = await copy.json(); } catch { error = {}; }
        const code = error.error?.code;
        if (upstream.status === 429) {
          const retry = Number(upstream.headers.get('retry-after'));
          this.scheduler.pause(slot, Number.isFinite(retry) && retry > 0 ? retry * 1000 : 15 * 60_000, code || 'rate_limited');
          await this.store.save(); lastError = upstream;
          // 仅在响应流开始前切换；绑定的加密上下文不可换号。
          if (!sessionOverride && this.scheduler.owner(body)) return this.pipe(upstream, res, slot);
          if (attempt === 1) return this.pipe(upstream, res, slot);
          continue;
        }
        if (upstream.status === 400 && code === 'subscription_sharing_unsupported_capability' && !this.scheduler.owner(body)) return primary();
        // 权限、区域、账号资格和已开始的流错误均原样返回，不换号绕过。
        return this.pipe(upstream, res, slot);
      } finally { this.scheduler.inFlight[slot]--; }
    }
  }
  async pipe(upstream, res, slot, { expectSSE = false } = {}) {
    const headers = responseHeaders(upstream);
    const sse = (expectSSE && upstream.ok) || upstream.headers.get('content-type')?.includes('text/event-stream');
    if (sse) headers['content-type'] = 'text/event-stream; charset=utf-8';
    res.writeHead(upstream.status, headers);
    const observer = sse && slot !== 'none' ? new SSEObserver(e => this.scheduler.observe(slot, e)) : null;
    if (!upstream.body) return res.end();
    const reader = upstream.body.getReader();
    try {
      while (!res.destroyed) {
        const { done, value } = await reader.read(); if (done) break;
        // 先登记加密上下文的所属账号，再让客户端看到事件。
        if (observer) await observer.push(value);
        if (!res.write(value)) await once(res, 'drain', { signal: AbortSignal.timeout(300_000) });
      }
      if (observer && !observer.completed && !observer.failed && !res.destroyed) {
        const message = localizeMessage('上游流未正常完成；没有自动重放请求', requestLanguage(res.req));
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { code: 'router_incomplete_stream', message } })}\n\n`);
      }
      res.end();
    } finally { await reader.cancel().catch(() => {}); }
  }
  async verifyAccount(slot) {
    if (!isAccountSlot(slot) || !Object.hasOwn(this.store.data.accounts, slot)) throw new RouterError('账号位置无效');
    if (this.verifying.has(slot)) throw new RouterError('验证正在进行，请稍候', 409);
    this.verifying.add(slot);
    this.scheduler.inFlight[slot] = (this.scheduler.inFlight[slot] ?? 0) + 1;
    try {
      const token = await this.auth.token(slot), headers = { authorization: `Bearer ${token}` };
      const list = await this.fetch(`${API}/models`, { headers });
      if (!list.ok) throw new RouterError(`模型列表查询失败（${list.status}）`, 502);
      const catalog = await list.json(), models = catalog.models ?? catalog.data ?? [];
      const model = models.find(m => (m.slug ?? m.id) === 'gpt-6.1-sol') ?? models.find(m => m.visibility === 'list' && (m.slug ?? m.id));
      if (!model) throw new RouterError('此账号没有可供验证的模型', 400);
      const slug = model.slug ?? model.id;
      const r = await this.fetch(`${API}/responses`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ model: slug, input: [{ role: 'user', content: 'Reply with exactly OK.' }], store: false, stream: true }), signal: AbortSignal.timeout(120_000) });
      if (!r.ok) {
        const data = await r.json().catch(() => ({})); const code = data.error?.code;
        throw new RouterError(`订阅推理验证失败（HTTP ${r.status}${typeof code === 'string' && /^[a-z_]+$/.test(code) ? `，${code}` : ''}）。请检查此工具的订阅授权和额度。`, 400);
      }
      const observer = new SSEObserver(e => this.scheduler.observe(slot, e));
      for await (const chunk of r.body) await observer.push(chunk);
      if (!observer.completed || observer.failed) throw new RouterError('验证请求没有成功完成，请检查账号授权与额度');
      this.store.data.accounts[slot].verified = true; this.store.data.accounts[slot].cooldownUntil = 0;
      await this.store.save(); return { ok: true, model: slug };
    } finally { this.verifying.delete(slot); this.scheduler.inFlight[slot]--; }
  }
  startQuotaMonitor() {
    if (this.quotaTimer) return;
    const poll = () => {
      if (this.quotaProcess) return;
      const batches = Math.ceil(Object.keys(this.store.data.accounts).length / QUOTA_QUERY_CONCURRENCY);
      const timeout = 15_000 + Math.max(1, batches) * 125_000;
      this.quotaProcess = execFile(process.execPath, [fileURLToPath(new URL('./quota.mjs', import.meta.url)), '--all', '--quiet', '--state', this.store.dir], { env: process.env, timeout, maxBuffer: 128 * 1024 }, () => {
        this.quotaProcess = null;
        this.scheduler.refreshQuotas().catch(() => {});
      });
    };
    poll();
    this.quotaTimer = setInterval(poll, 60_000);
    this.quotaTimer.unref();
  }
}
