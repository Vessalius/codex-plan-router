// Keep stable error codes and Chinese diagnostics while localizing client-facing messages.
const messages = new Map([
  ['请从安装时提供的设置链接进入', 'Open Settings from the application menu.'],
  ['订阅请求未正常完成', 'The subscription request did not complete.'],
  ['账号位置无效', 'Invalid account slot.'],
  ['会话 ID 格式无效', 'Invalid conversation ID.'],
  ['方法不允许', 'Method not allowed.'],
  ['接口不存在', 'Endpoint not found.'],
  ['管理接口不存在', 'Management endpoint not found.'],
  ['缺少客户端认证', 'Client authentication is missing.'],
  ['请等待当前任务结束后再停止后台', 'Wait for the active request to finish before stopping the backend.'],
  ['此账号仍有请求运行，请完成后再断开', 'Wait for the active requests on this account before disconnecting it.'],
  ['验证正在进行，请稍候', 'Verification is already running.'],
  ['验证请求没有成功完成，请检查账号授权与额度', 'Verification did not complete. Check authorization and quota.'],
  ['此账号没有可供验证的模型', 'This account has no eligible model for verification.'],
  ['此账号尚未授权使用订阅额度，请重新授权', 'This account has not granted plan access. Authorize it again.'],
  ['此账号需要重新登录', 'This account needs to sign in again.'],
  ['不能重复连接同一个个人账号，请在浏览器选择其他账号', 'This account is already connected. Choose a different account in the browser.'],
  ['此账号位置刚完成了授权，请返回设置重试', 'This slot was just authorized. Return to Settings and try again.'],
  ['登录事务已过期或校验失败，请重新登录', 'The sign-in session expired or could not be verified. Sign in again.'],
  ['登录或订阅授权未完成，可以重新尝试', 'Sign-in or plan authorization did not complete. You can try again.'],
  ['登录账号与所选已保存账号不一致', 'The signed-in account does not match the selected account.'],
  ['返回的客户端注册与所选账号不一致', 'The client registration does not match the selected account.'],
  ['登录未返回完整的账号注册信息', 'The sign-in response did not include complete registration details.'],
  ['授权服务暂不可用，请返回设置页重试', 'Authorization is unavailable. Return to Settings and try again.'],
  ['登录返回的身份令牌格式无效', 'The sign-in response returned an invalid identity token.'],
  ['登录返回的身份令牌无法解析', 'Could not read the identity token from the sign-in response.'],
  ['身份令牌签名算法无效', 'Unsupported identity token signature algorithm.'],
  ['身份令牌签名验证失败', 'Identity token signature verification failed.'],
  ['身份令牌的账号、有效期或登录事务验证失败', 'Identity token validation failed for this sign-in.'],
  ['OAuth 发行方无效', 'Invalid OAuth issuer.'],
  ['OAuth 服务地址无效', 'Invalid OAuth service URL.'],
  ['授权服务返回的访问令牌无效', 'The authorization service returned an invalid access token.'],
  ['远端撤销未确认，保留本地授权以便重试', 'Revocation could not be confirmed. The local session was kept so you can try again.'],
  ['请先登录并验证至少两个不同账号', 'Connect and verify at least two different accounts first.'],
  ['已有代理配置经过改动，请先手动检查', 'The existing proxy configuration was edited. Review it first.'],
  ['已有自定义模型提供商或请求地址配置，未自动覆盖', 'A custom provider or endpoint is already configured. Review it before enabling the proxy.'],
  ['配置刚刚被其他程序修改，请重试', 'Another program just updated the configuration. Try again.'],
  ['代理配置已被手动修改，未覆盖你的改动', 'The proxy configuration has manual changes. Review them before restoring the direct connection.'],
  ['无法验证现有配置；需要带 tomllib 的 Python 3.11 或更高版本', 'Could not validate the configuration. Python 3.11 or later with tomllib is required.'],
  ['配置验证失败', 'Configuration validation failed.'],
  ['配置已启用。请等所有任务结束后手动退出并重新打开客户端；工具不会主动重启客户端。', 'Proxy configured. Finish your tasks, then quit and reopen Codex to apply it.'],
  ['已移除代理配置。请等任务结束后重新打开客户端生效。后台服务仍在运行，供当前连接收尾。', 'Proxy configuration removed. Finish your tasks and reopen Codex. The backend will finish current connections.'],
  ['没有可用账号，请在本地设置中检查授权与暂停状态', 'No account is available. Check authorization and pause status in Settings.'],
  ['当前上下文所属账号暂不可用或额度已耗尽，保留会话并等待恢复', 'The account for this context is unavailable or out of quota. Wait for it to recover.'],
  ['上下文含有来自不同账号的加密内容，已停止发送以保护会话', 'The context contains encrypted items from different accounts. The request was stopped to protect the conversation.'],
  ['当前加密上下文属于代理账号，不能交给主号做远端压缩；未跨账号发送上下文', 'The encrypted context belongs to a proxy account. Remote compaction via the primary account is unavailable.'],
  ['当前请求包含此订阅通道不支持的能力，且上下文绑定代理账号；已保留会话，请关闭相关能力后重试', 'This request uses an unsupported feature and its context is bound to a proxy account. Disable the feature and retry.'],
  ['此客户端请求的功能尚未验证，未转发此接口', 'The proxy does not support this client endpoint.'],
  ['本地代理请求失败；未重放已经开始的请求', 'The local proxy request failed. In-progress requests were not retried.'],
  ['代理流中断，请检查连接；没有自动重放请求', 'The proxy stream was interrupted. Check the connection. The request was not retried.'],
  ['上游流未正常完成；没有自动重放请求', 'The upstream stream did not finish. The request was not retried.'],
  ['请求体过大', 'The request body is too large.'],
  ['请求不是有效 JSON', 'The request is not valid JSON.'],
  ['不支持的请求压缩格式', 'Unsupported request compression.'],
  ['拒绝不匹配的本地地址', 'The local host address did not match.'],
  ['拒绝跨站请求', 'Cross-site requests are blocked.'],
  ['拒绝访问非官方上游地址', 'The upstream address is not an official endpoint.'],
  ['上游事件超过允许大小', 'The upstream event exceeded the size limit.'],
  ['此实例为离线验证模式', 'This instance is running in offline verification mode.'],
  ['端口必须在 1024 到 65535 之间', 'The port must be between 1024 and 65535.'],
  ['后台锁文件需要检查，未启动第二个进程', 'Check the backend lock file. A second process was not started.'],
  ['后台锁文件无效', 'Invalid backend lock file.'],
  ['后台服务已在运行', 'The backend is already running.'],
  ['无法取得后台进程锁', 'Could not acquire the backend lock.'],
  ['本地管理请求失败', 'The local management request failed.'],
  ['此平台请使用便携启动脚本，或运行 node cli.mjs serve', 'Use the installer for this platform, or run node cli.mjs serve.'],
  ['后台启动失败，请检查端口或现有实例', 'The backend could not start. Check the port and any existing instance.'],
  ['后台仍在退出，请稍后重试', 'The backend is still shutting down. Try again shortly.'],
  ['已移除代理配置，请在任务结束后重新打开客户端。', 'Proxy configuration removed. Finish your tasks, then reopen Codex.'],
  ['操作失败，请检查网络、文件权限或后台服务状态。', 'The operation failed. Check the network, file permissions, and backend status.'],
  ['网络代理地址格式无效，未保存网络配置', 'Invalid proxy URL. Network configuration was not saved.'],
  ['自启动只支持不含凭据和附加数据的本机回环代理地址，未保存现有网络环境', 'The login service accepts only a credential-free loopback proxy URL. Network configuration was not saved.'],
  ['程序已安装，但自启动服务重载失败；请稍后重新运行 install', 'The app was installed, but the login service could not reload. Retry install.'],
  ['服务已加载，但尚未通过就绪检查，请查看本地服务日志', 'The service loaded but did not become ready. Check the local service log.'],
  ['额度工具不允许执行此操作', 'This operation is unavailable in the quota tool.'],
  ['独立 Codex 账号请求未能完成，请检查授权状态', 'The independent Codex account request failed. Check authorization.'],
  ['独立账号服务连接已关闭', 'The independent account connection closed.'],
  ['独立账号服务请求超时', 'The independent account request timed out.'],
  ['无法连接独立账号服务', 'Could not connect to the independent account service.'],
  ['登录未完成，请重新授权', 'Sign-in did not complete. Authorize again.'],
  ['等待浏览器授权超时，请重新打开授权入口', 'Browser authorization timed out. Open the authorization flow again.'],
  ['独立账号锁文件需要检查', 'Check the independent account lock file.'],
  ['此账号正在授权或刷新，请稍后重试', 'This account is being authorized or refreshed. Try again shortly.'],
  ['独立账号服务忙', 'The independent account service is busy.'],
  ['请先在代理设置中连接此账号', 'Connect this account in the proxy settings first.'],
  ['官方登录地址验证失败', 'Could not validate the official sign-in URL.'],
  ['用法：node quota-native.mjs login <账号编号>', 'Usage: node quota-native.mjs login <account-slot>'],
]);

export const languageFrom = (preference, fallback = 'zh') => {
  if (typeof preference !== 'string' || !preference.trim()) return fallback;
  const locales = preference.split(',').map(entry => {
    const [code, quality] = entry.trim().split(';');
    return { code: code.toLowerCase(), weight: quality ? Number(quality.trim().replace(/^q=/i, '')) : 1 };
  });
  const best = locales.filter(({ weight }) => weight > 0).sort((a, b) => b.weight - a.weight)
    .find(({ code }) => /^zh(?:[-_]|$)|^en(?:[-_]|$)/.test(code));
  return best?.code.startsWith('zh') ? 'zh' : 'en';
};

export const cliLanguage = () => languageFrom(process.env.CODEX_ROUTER_LANGUAGE, 'en');
export const bilingual = (language, zh, en) => language === 'zh' ? zh : en;

export function localizeMessage(value, language) {
  if (language === 'zh' || typeof value !== 'string') return value;
  if (messages.has(value)) return messages.get(value);
  const status = value.match(/^(授权服务返回|模型列表查询失败（|订阅推理验证失败（HTTP )\s*(\d+)/);
  if (status) {
    const kind = { '授权服务返回': 'Authorization failed', '模型列表查询失败（': 'Model list request failed', '订阅推理验证失败（HTTP ': 'Plan verification failed' };
    const allowlistedCode = value.match(/[（，]([a-z_]+)）/);
    return kind[status[1]] + ' (HTTP ' + status[2] + (allowlistedCode ? ', ' + allowlistedCode[1] : '') + ').';
  }
  const wrong = value.match(/^登录的不是账号 ([A-Z]+)/);
  if (wrong) return 'The login does not match account ' + wrong[1] + '. Authorize again and choose the correct account.';
  const missing = value.match(/^账号 ([A-Z]+) 尚未完成独立 Codex 登录/);
  if (missing) return 'Account ' + missing[1] + ' has not completed independent Codex sign-in.';
  return value;
}
