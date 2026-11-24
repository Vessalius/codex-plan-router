const text = {
  title: ['Codex 多账号代理', 'Codex Plan Router'],
  intro: ['按额度给已授权的 ChatGPT 账号分配兼容的 Codex 请求。', 'Route compatible Codex requests across authorized ChatGPT accounts based on their quota.'],
  language: ['界面语言', 'Language'],
  system: ['跟随浏览器', 'Browser default'],
  accounts: ['账号管理', 'Accounts'],
  account: ['账号 {slot}', 'Account {slot}'],
  signInIntro: ['在 OpenAI 页面选择账号，授权此工具使用订阅。', 'Choose an account on the OpenAI sign-in page and grant subscription access.'],
  add: ['添加账号', 'Add account'],
  loading: ['正在读取状态…', 'Loading status…'],
  connection: ['桌面连接', 'Desktop connection'],
  verifyIntro: ['启用代理前，至少验证两个账号。每次验证会消耗少量订阅额度。', 'Verify at least two accounts before enabling the proxy. Each check uses a small amount of subscription quota.'],
  primary: ['Codex 当前登录账号', 'Current Codex account'],
  none: ['尚未指定', 'Not set'],
  primaryHelp: ['此选项用于统计直连的用量，请在 Codex 账号菜单切换实际登录。', 'This setting assigns direct usage to an account for statistics. Use the Codex account menu to change the actual login.'],
  enable: ['启用桌面代理', 'Enable desktop proxy'],
  disable: ['恢复官方直连', 'Restore direct connection'],
  restart: ['更改连接后，等任务完成再重新打开 Codex。', 'After changing the connection, finish your tasks and reopen Codex.'],
  routing: ['请求分配', 'Request routing'],
  policy: ['新请求优先按五小时、每周剩余额度和重置时间分配。额度数据不完整时，参考近期观察用量。', 'New requests are routed using 5-hour and weekly quota and reset times. If quota data is incomplete, routing uses recent observed usage.'],
  context: ['已有上下文通常沿用原账号。响应开始后，代理不会换账号重发。', 'Existing context normally stays with its original account. The proxy never retries a response with another account once streaming begins.'],
  manageUsage: ['查看官方用量与授权', 'View official usage and permissions'],
  initial: ['在本机连接需要使用的账号。', 'Connect the accounts you want to use on this device.'],
  failed: ['请求失败，请检查后台服务。', 'Request failed. Check the local backend.'],
  popup: ['请允许此页面打开登录窗口。', 'Allow pop-ups for this page to open the sign-in window.'],
  authorize: ['请在 OpenAI 页面完成授权，然后返回此页。', 'Complete authorization on the OpenAI page, then return here.'],
  notConnected: ['尚未连接', 'Not connected'],
  needsLogin: ['需要重新登录', 'Sign in again'],
  verified: ['已验证', 'Verified'],
  awaiting: ['已授权，待验证', 'Authorized, awaiting verification'],
  notAuthorized: ['未授权订阅', 'Subscription access not granted'],
  remaining: ['官方剩余 · 五小时 {five} · 每周 {week}', 'Official remaining · 5-hour {five} · Weekly {week}'],
  reauthorize: ['重新授权', 'Reauthorize'],
  verify: ['验证账号（少量真实用量）', 'Verify account (uses quota)'],
  verifiedResult: ['账号 {slot} 已验证，模型 {model}。', 'Account {slot} verified with model {model}.'],
  revoke: ['撤销此工具授权', 'Revoke app access'],
  revokePrompt: ['撤销此工具的订阅授权？桌面客户端仍保持登录。', 'Revoke this app’s subscription access? The desktop client stays signed in.'],
  revoked: ['已撤销账号授权。', 'Account authorization revoked.'],
  paused: ['暂缓调度至 {time}（非官方重置时间）', 'Routing paused until {time} (local estimate)'],
  enabledConfigured: ['已配置桌面代理，重新打开 Codex 后生效。', 'Desktop proxy configured. Reopen Codex to apply.'],
  modified: ['代理配置已被改动，请检查配置文件。', 'The proxy configuration was edited. Check the configuration file.'],
  direct: ['桌面客户端使用官方直连。', 'The desktop client uses a direct connection.'],
  next: ['下一条可自由分配的请求 · {account} · {basis}', 'Next unbound request · {account} · {basis}'],
  noAccount: ['暂无可用账号', 'No accounts available'],
  official: ['官方额度', 'Official quota'],
  observed: ['本地观察用量', 'Observed usage'],
  usage: ['代理完成 {routed} 次 · 原生通道请求 {direct} 次', 'Proxied: {routed} · Direct: {direct}'],
  primarySaved: ['已更新统计主号。', 'Primary account for statistics updated.'],
  enablePrompt: ['启用会更新 Codex 请求配置。等任务结束后，需手动重新打开客户端。是否继续？', 'Enabling the proxy updates the Codex connection. Finish your tasks, then reopen Codex to apply it. Continue?'],
  missingKey: ['设置链接缺少访问凭证。请从系统应用菜单或 dashboard 命令重新打开。', 'The settings link is missing its local credentials. Reopen it from the application menu or with the dashboard command.'],
};

export const HTML = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex Plan Router</title>
<style>
body{font:16px/1.6 system-ui,sans-serif;background:#f5f5f2;color:#222;max-width:850px;margin:40px auto;padding:0 20px}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
h1{font-size:29px;margin:0}h2{font-size:20px;margin-top:0}
section{background:white;padding:24px;border-radius:14px;margin:18px 0;border:1px solid #ddd}
button,select{font:inherit;font-size:14px;padding:7px 11px;border:1px solid #aaa;border-radius:7px;background:white}
button{cursor:pointer;margin:4px 8px 4px 0}button.primary{background:#202d2a;color:white}button:disabled{opacity:.5;cursor:default}
.muted{color:#666;font-size:14px}#message{white-space:pre-wrap}a{color:#176445}.error{color:#a12828}
.account + .account{border-top:1px solid #eee;margin-top:14px}
</style>
<header>
  <h1 data-msg="title"></h1>
  <label><span data-msg="language"></span> <select id="language">
    <option value="system" data-msg="system"></option><option value="zh">简体中文</option><option value="en">English</option>
  </select></label>
</header>
<p data-msg="intro"></p>
<section>
  <h2 data-msg="accounts"></h2><p class="muted" data-msg="signInIntro"></p>
  <button id="add-account" data-msg="add" disabled></button><div id="accounts" data-msg="loading"></div>
</section>
<section>
  <h2 data-msg="connection"></h2><p data-msg="verifyIntro"></p>
  <p><label><span data-msg="primary"></span> <select id="primary-slot" disabled></select></label></p>
  <p class="muted" data-msg="primaryHelp"></p>
  <button id="enable" class="primary" data-msg="enable" disabled></button><button id="disable" data-msg="disable" disabled></button>
  <p id="desktop" class="muted"></p><p class="muted" data-msg="restart"></p>
</section>
<section>
  <h2 data-msg="routing"></h2><p id="allocation"></p><p id="usage"></p><p data-msg="policy"></p><p data-msg="context"></p>
  <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer" data-msg="manageUsage"></a>
</section>
<section id="message" role="status"></section>
<script>
const messages = ${JSON.stringify(text).replaceAll('<', '\\u003c')};
const $ = id => document.getElementById(id);
const key = location.hash.slice(1);
history.replaceState(null, '', '/');
let preference = 'system', language = 'en', busy = false, snapshot;
try {
  const stored = localStorage.getItem('routerLanguage');
  if (['system', 'zh', 'en'].includes(stored)) preference = stored;
} catch {}
function t(id, fields = {}) {
  return messages[id][language === 'zh' ? 0 : 1].replace(/{(\\w+)}/g, (token, name) => fields[name] ?? token);
}
function applyLanguage() {
  language = preference === 'system' ? (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en') : preference;
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  document.title = t('title');
  document.querySelectorAll('[data-msg]').forEach(node => { node.textContent = t(node.dataset.msg); });
  $('language').value = preference;
  if (snapshot) render(snapshot);
  show(t(key ? 'initial' : 'missingKey'), !key);
}
async function api(path, body) {
  const headers = { 'x-router-key': key, 'Accept-Language': language };
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch('/admin/' + path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw Error(result.error?.message || t('failed'));
  return result;
}
function show(value, error = false) {
  $('message').textContent = value;
  $('message').className = error ? 'error' : '';
}
async function act(action) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button,#language,#primary-slot').forEach(node => { node.disabled = true; });
  try { await action(); } catch (error) { show(error.message, true); }
  finally { busy = false; $('language').disabled = false; await refresh(); }
}
function connectAccount(slot) {
  if (busy) return;
  const popup = window.open('about:blank', '_blank');
  act(async () => {
    try {
      if (!popup) throw Error(t('popup'));
      const result = await api('login', { slot });
      popup.location = result.url;
      show(t('authorize'));
    } catch (error) { popup?.close(); throw error; }
  });
}
function render(s) {
  const accountName = slot => t('account', { slot: slot.toUpperCase() });
  const options = s.accounts.filter(account => account.registered).map(account => new Option(accountName(account.slot), account.slot));
  $('primary-slot').replaceChildren(new Option(t('none'), ''), ...options);
  $('primary-slot').value = s.primarySlot;
  $('primary-slot').disabled = busy;
  $('add-account').disabled = busy;
  $('accounts').removeAttribute('data-msg');
  $('accounts').replaceChildren();
  for (const account of s.accounts) {
    const card = document.createElement('div');
    const slot = account.slot.toUpperCase();
    card.className = 'account';
    const paragraph = (value, muted = false) => {
      const node = document.createElement('p');
      node.textContent = value;
      if (muted) node.className = 'muted';
      card.append(node);
    };
    const button = (id, action) => {
      const node = document.createElement('button');
      node.textContent = t(id);
      node.disabled = busy;
      node.onclick = action;
      card.append(node);
    };
    const state = account.needsLogin ? 'needsLogin' : account.verified ? 'verified' : account.enabled ? 'awaiting' : 'notAuthorized';
    paragraph([accountName(account.slot), account.email || t('notConnected'), account.registered ? t(state) : null].filter(Boolean).join(' · '));
    if (account.registered) {
      const q = account.allocationQuota;
      const percent = value => value ? Math.floor(value.remainingPercent) + '%' : '—';
      paragraph(t('remaining', { five: percent(q?.fiveHour), week: percent(q?.weekly) }), true);
    }
    button(account.registered ? 'reauthorize' : 'add', () => connectAccount(account.slot));
    if (account.enabled && !account.needsLogin) button('verify', () => act(async () => {
      const { model } = await api('verify', { slot: account.slot });
      show(t('verifiedResult', { slot, model }));
    }));
    if (account.enabled) button('revoke', () => {
      if (confirm(t('revokePrompt'))) act(async () => { await api('disconnect', { slot: account.slot }); show(t('revoked')); });
    });
    if (account.cooldownUntil > Date.now()) paragraph(t('paused', { time: new Date(account.cooldownUntil).toLocaleString(document.documentElement.lang) }), true);
    $('accounts').append(card);
  }
  $('enable').disabled = busy || s.desktop.enabled || s.desktop.modified ||
    s.accounts.filter(a => a.verified && a.enabled && !a.needsLogin).length < 2;
  $('disable').disabled = busy || !s.desktop.enabled;
  $('desktop').textContent = t(s.desktop.modified ? 'modified' : s.desktop.enabled ? 'enabledConfigured' : 'direct');
  if (s.allocation) {
    const slot = s.allocation.nextUnboundAccount;
    $('allocation').textContent = t('next', {
      account: slot ? accountName(slot) : t('noAccount'),
      basis: t(s.allocation.nextBasis === 'official_quota' ? 'official' : 'observed')
    });
  }
  $('usage').textContent = t('usage', { routed: s.routed, direct: s.fallbacks });
}
async function refresh() {
  try { snapshot = await api('status'); render(snapshot); }
  catch (error) { show(error.message, true); }
}
$('language').onchange = event => {
  preference = event.target.value;
  try { localStorage.setItem('routerLanguage', preference); } catch {}
  applyLanguage();
};
$('add-account').onclick = () => connectAccount('');
$('primary-slot').onchange = event => {
  const slot = event.target.value;
  act(async () => { await api('primary', { slot }); show(t('primarySaved')); });
};
$('enable').onclick = () => {
  if (confirm(t('enablePrompt'))) act(async () => show((await api('enable', {})).message));
};
$('disable').onclick = () => act(async () => show((await api('disable', {})).message));
applyLanguage();
if (key) { refresh(); setInterval(() => { if (!busy) refresh(); }, 5000); }
</script></html>`;
