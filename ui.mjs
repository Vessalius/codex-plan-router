export const HTML = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex 多账号代理</title>
<style>body{font:16px/1.65 system-ui,sans-serif;background:#f5f5f2;color:#222;max-width:850px;margin:40px auto;padding:0 20px}h1{font-size:29px}h2{font-size:20px}section{background:white;padding:24px;border-radius:14px;margin:18px 0;border:1px solid #ddd}button{padding:10px 17px;border:1px solid #aaa;border-radius:7px;background:white;cursor:pointer;margin:5px 8px 5px 0;font-size:14px}button.primary{background:#202d2a;color:white}button:disabled{opacity:.5;cursor:wait}.muted{color:#666;font-size:14px}.badge{font-weight:600}#message{white-space:pre-wrap}a{color:#176445}code{overflow-wrap:anywhere}.error{color:#a12828}</style>
<h1>Codex 多账号代理</h1><p>桌面客户端保持主号登录，模型请求按代理观察到的用量分配给已授权账号。</p>
<section><h2>1. 连接个人账号</h2><p class="muted">在浏览器选择要连接的账号，并允许此工具使用 ChatGPT 订阅。无需提供密码、API Key，也不会读取桌面客户端的登录文件。</p><button id="add-account">添加账号</button><div id="accounts">正在读取状态…</div></section>
<section><h2>2. 验证后启用</h2><p>每个账号的验证会发送一条很短的真实模型请求，消耗少量订阅额度。至少两个账号验证成功后，才允许启用桌面代理。</p><p><label>桌面客户端当前登录的主号对应：<select id="primary-slot"><option value="">尚未指定</option></select></label></p><p class="muted">指定主号后，代理观察到的原生主号请求用量也会计入对应账号，帮助调度。不会更改桌面登录。</p><button id="enable" class="primary">启用桌面代理</button><button id="disable">恢复官方直连</button><p id="desktop" class="muted"></p><p class="muted">首次启用或恢复直连后，需要你在所有任务完成时手动退出并重新打开客户端。工具不会主动重启客户端。</p></section>
<section><h2>运行状态与边界</h2><p id="usage"></p><p id="allocation"></p><p>优先依据各账号的官方五小时、每周剩余额度及重置时间分配新请求，兼顾并发。任何窗口已耗尽的账号不接新请求。官方数据超过三分钟或不完整时，退回代理观察用量均衡；不会猜测重置后的额度。</p><p>已有加密上下文固定使用原账号。无法兼容的工具请求保留主号处理；绑定代理账号的上下文不强制切回主号。响应开始后不会换号重放。</p><p>本工具在使用你的 ChatGPT 订阅。<a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">管理订阅额度与工具授权</a></p></section>
<section id="message" role="status">请完成账号连接。授权信息只保存在本机受保护的目录。</section>
<script>
let key=location.hash.slice(1);history.replaceState(null,'','/');
const $=id=>document.getElementById(id);let busy=false;
async function api(path,body){const r=await fetch('/admin/'+path,{method:body?'POST':'GET',headers:{'x-router-key':key,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const d=await r.json();if(!r.ok)throw Error(d.error?.message||'请求失败');return d}
function show(text,error=false){$('message').textContent=text;$('message').className=error?'error':''}
async function act(fn){if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn()}catch(e){show(e.message,true)}finally{busy=false;await refresh()}}
function connectAccount(slot){
  const popup=window.open('about:blank','_blank');
  act(async()=>{
    try{
      if(!popup)throw Error('请允许此设置页打开登录窗口后重试');
      const result=await api('login',{slot});
      popup.location=result.url;
      show('请在新窗口完成登录授权，然后返回此页。');
    }catch(error){popup?.close();throw error}
  });
}
async function refresh(){try{const s=await api('status');$('primary-slot').replaceChildren(new Option('尚未指定',''),...s.accounts.filter(a=>a.registered).map(a=>new Option('账号 '+a.slot.toUpperCase(),a.slot)));$('primary-slot').value=s.primarySlot;$('add-account').disabled=busy;$('accounts').replaceChildren();for(const a of s.accounts){const div=document.createElement('div');const p=document.createElement('p');p.textContent='账号 '+a.slot.toUpperCase()+' · '+(a.email||'尚未连接')+' · '+(a.needsLogin?'需要重新登录':a.verified?'已验证':a.enabled?'已授权，待验证':a.registered?'未授权订阅':'未登录');div.append(p);if(a.registered){const q=a.allocationQuota;const line=document.createElement('p');const pct=window=>window?Math.floor(window.remainingPercent)+'%':'—';line.className='muted';line.textContent='官方剩余 · 五小时 '+pct(q?.fiveHour)+' · 每周 '+pct(q?.weekly);div.append(line)}const make=(text,fn)=>{const b=document.createElement('button');b.textContent=text;b.disabled=busy;b.onclick=fn;div.append(b)};make(a.registered?'重新授权':'Continue with ChatGPT',()=>connectAccount(a.slot));if(a.enabled&&!a.needsLogin)make('验证账号（少量真实用量）',()=>act(async()=>{const d=await api('verify',{slot:a.slot});show('账号 '+a.slot.toUpperCase()+' 已完成真实推理验证，模型：'+d.model)}));if(a.enabled)make('撤销此工具授权',()=>{if(confirm('撤销此工具在该账号的授权？不会退出桌面客户端。'))act(async()=>{await api('disconnect',{slot:a.slot});show('已撤销该账号对此工具的授权。')})});if(a.cooldownUntil>Date.now()){const p=document.createElement('p');p.className='muted';p.textContent='暂缓调度至 '+new Date(a.cooldownUntil).toLocaleString()+'。这不是官方额度重置时间。';div.append(p)}$('accounts').append(div)}$('enable').disabled=busy||s.desktop.enabled||s.accounts.filter(a=>a.verified&&a.enabled&&!a.needsLogin).length<2;$('disable').disabled=busy||!s.desktop.enabled;$('desktop').textContent=s.desktop.enabled?'桌面代理配置已启用；运行中的客户端是否已加载配置，需要重新打开后验证。':s.desktop.modified?'代理配置被手动改动，请检查配置文件。':'桌面客户端仍使用官方直连，当前会话未改动。';$('allocation').textContent=s.allocation?'当前策略：官方额度与重置时间优先。下一条可自由分配请求：'+(s.allocation.nextUnboundAccount?s.allocation.nextUnboundAccount.toUpperCase():'暂无可用账号')+'；依据：'+(s.allocation.nextBasis==='official_quota'?'官方额度':'本地观察用量后备'):'正在等待后台策略更新';$('usage').textContent='代理完成 '+s.routed+' 次请求；主号处理 '+s.fallbacks+' 次请求。最近五小时观察值：'+s.accounts.map(a=>a.slot.toUpperCase()+' '+Math.round(a.observedScore)).join(' / ')}catch(e){show(e.message,true)}}
$('add-account').onclick=()=>connectAccount('');
$('primary-slot').onchange=()=>act(async()=>{await api('primary',{slot:$('primary-slot').value});show('已更新主号对应关系，只影响后续观察用量的归属。')});
$('enable').onclick=()=>{if(confirm('启用将备份并修改 Codex 模型请求配置；请在任务结束后手动重新打开客户端。继续？'))act(async()=>show((await api('enable',{})).message))};$('disable').onclick=()=>act(async()=>show((await api('disable',{})).message));if(!key)show('设置链接缺少访问凭证，请运行本地工具的 dashboard 命令重新打开。',true);else{refresh();setInterval(()=>{if(!busy)refresh()},5000)}
</script></html>`;
