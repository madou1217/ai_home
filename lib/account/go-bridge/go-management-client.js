'use strict';

// Go 管理 API（/v1/management/*）的最小客户端。只做传输与错误结构化，不做业务决策；
// Management Key 只进 Authorization 头，不进 URL、日志或错误文本。

function createGoManagementClient(options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  const managementKey = String(options.managementKey || '');
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000;
  // 插件最终在 Node 宿主进程里执行，engines 必须按真实宿主版本判断；
  // 这两个头只发给管理面的 install，不参与鉴权，也不进 URL/日志。
  const hostVersion = String(options.hostVersion || '').trim();
  const nodeVersion = String(options.nodeVersion || process.versions.node || '').trim();
  if (!baseUrl || !managementKey) throw new Error('go management client requires baseUrl and managementKey');

  async function call(method, path, body, extraHeaders) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      // 字符串 body 视为「已经序列化好的 JSON」原样转发：导入负载可能接近 80MB，
      // 二次 JSON.stringify 只会白白多占一份内存。
      const rawBody = typeof body === 'string';
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${managementKey}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(extraHeaders || {})
        },
        body: body === undefined ? undefined : (rawBody ? body : JSON.stringify(body)),
        signal: controller.signal
      });
      const raw = await response.text();
      let json = null;
      try { json = raw ? JSON.parse(raw) : null; } catch (_error) {}
      const error = json && json.error && typeof json.error === 'object' ? json.error : null;
      return {
        ok: response.ok,
        status: response.status,
        data: json && Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json,
        page: json && json.page ? json.page : null,
        // 完整响应体：少数接口在 data 之外还有游标字段（如用量事件的 boot_id / latest_seq）。
        body: json,
        errorCode: error ? String(error.code || '') : (response.ok ? '' : `http_${response.status}`)
      };
    } catch (error) {
      return { ok: false, status: 0, data: null, page: null, errorCode: error && error.name === 'AbortError' ? 'timeout' : 'network_error' };
    } finally {
      clearTimeout(timer);
    }
  }

  // 插件发布投影：整体替换 Go 的存活代次集合，返回 Go 已接受的代次（data.generations）。
  function pushPluginProjection(payload) {
    return call('PUT', '/v1/management/plugins/projection', payload);
  }

  // 只读插件清单：控制面事实来自 Node 的 app-state.db，运行态来自 Go 已确认的投影。
  // 写入口（安装 / 启停 / 卸载）仍在 Node，Go 对非 GET 返回 405。
  function getPluginInventory() {
    return call('GET', '/v1/management/plugins');
  }

  // 插件发布者信任根：文件型写面在 Go（<aiHomeDir>/plugins/trusted-keys.json）。
  // Node 只转发 WebUI 请求；install 校验与 CLI 仍直接读/写同一个文件。
  function getPluginTrustedKeys() {
    return call('GET', '/v1/management/plugins/trusted');
  }

  function addPluginTrustedKey(payload) {
    return call('POST', '/v1/management/plugins/trust', payload);
  }

  function removePluginTrustedKey(keyId) {
    return call('POST', '/v1/management/plugins/untrust', { keyId });
  }

  // 插件安装/卸载：制品校验、签名、清单与状态 CAS 都在 Go；启用/停用仍在 Node。
  // 宿主版本随 install 一起下发，Go 不猜 engines 的判定依据。
  function installPlugin(payload) {
    const headers = {};
    if (hostVersion) headers['x-aih-host-version'] = hostVersion;
    if (nodeVersion) headers['x-aih-node-version'] = nodeVersion;
    return call('POST', '/v1/management/plugins/install', payload, headers);
  }

  function uninstallPlugin(payload) {
    return call('POST', '/v1/management/plugins/uninstall', payload);
  }

  // 控制状态 CAS 提交：候选由 Node 计算，Go 只校验结构/操作边界并原样落盘。
  // 这是 enable/disable 的底层写入口（P2 由 Go 的实例端点调用；Node 只保留回滚能力）。
  // SSH 远端目录浏览：Go 用已保存连接执行，Node 不接收浏览器凭据。
  // SSH 反向隧道：状态读取与配置变更后的 reconcile。
  function getSlashCommands(provider) {
    const params = new URLSearchParams({ provider: String(provider || '') });
    return call('GET', `/v1/management/webui/slash-commands?${params.toString()}`);
  }
  function setWebUIMobile(provider, accountRef) {
    return call('POST', `/v1/management/webui/accounts/${encodeURIComponent(provider)}/${encodeURIComponent(accountRef)}/set-mobile`);
  }
  function clearWebUIMobile(provider, accountRef) {
    return call('POST', `/v1/management/webui/accounts/${encodeURIComponent(provider)}/${encodeURIComponent(accountRef)}/clear-mobile`);
  }
  function setWebUIDefault(provider, accountRef) {
    return call('POST', `/v1/management/webui/accounts/${encodeURIComponent(provider)}/${encodeURIComponent(accountRef)}/set-default`);
  }
  function clearWebUIDefault(provider, accountRef) {
    return call('POST', `/v1/management/webui/accounts/${encodeURIComponent(provider)}/${encodeURIComponent(accountRef)}/clear-default`);
  }
  // kimi 桌面端托管登录与套餐统计：QR/Membership RPC、会话托管与出口解析都在 Go。
  // Node 只转发请求体并把 Go 的状态码/响应体原样交回路由。
  function startKimiDesktopSession(provider, accountRef) {
    return call(
      'POST',
      '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
        '/' + encodeURIComponent(accountRef) + '/desktop-session/start'
    );
  }
  function pollKimiDesktopSession(provider, accountRef, code) {
    return call(
      'POST',
      '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
        '/' + encodeURIComponent(accountRef) + '/desktop-session/poll',
      { code: String(code || '') }
    );
  }
  function getKimiPlanStats(provider, accountRef, refresh) {
    const query = refresh === true ? '?refresh=1' : '';
    return call(
      'GET',
      '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
        '/' + encodeURIComponent(accountRef) + '/plan-stats' + query
    );
  }
  function updateAccountRoutingRules(provider, accountRef, payload) {
    return call(
      'POST',
      '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
        '/' + encodeURIComponent(accountRef) + '/routing-rules',
      payload
    );
  }
  function restoreAccountScheduling(provider, accountRef) {
    return call('POST', `/v1/management/webui/accounts/${encodeURIComponent(provider)}/${encodeURIComponent(accountRef)}/restore-scheduling`);
  }
  // 账号活动：任务状态与限流在 Go，执行仍由 Node 的 handler 完成（Go 通过内部桥回调）。
  // 五个方法成组出现：run/probe 返回 202/200，jobs 轮询，params 供编辑器，单账号动作同步完成。
  // 活动任务走独立前缀：Go 的 ServeMux 不允许 /accounts/activity/jobs/{id} 与
  // /accounts/{provider}/{accountRef}/quota-reset-events 共存（互不包含的歧义模式）。
  function runAccountActivity(payload) {
    return call('POST', '/v1/management/webui/account-activity/run', payload);
  }
  function probeAccountActivity(payload) {
    return call('POST', '/v1/management/webui/account-activity/probe', payload);
  }
  function getAccountActivityJob(jobId) {
    return call('GET', `/v1/management/webui/account-activity/jobs/${encodeURIComponent(String(jobId || ''))}`);
  }
  function listAccountActivityParams(provider, actionId) {
    const search = new URLSearchParams({
      provider: String(provider || ''),
      actionId: String(actionId || '')
    });
    return call('GET', `/v1/management/webui/account-activity/params?${search.toString()}`);
  }
  function runAccountActivityForAccount(provider, accountRef, actionId) {
    return call(
      'POST',
      '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
        '/' + encodeURIComponent(accountRef) + '/activity/' + encodeURIComponent(actionId)
    );
  }
  function getSessionMessages(provider, sessionId, queryString) {
    const suffix = queryString ? `?${queryString}` : '';
    return call('GET', `/v1/management/webui/sessions/${encodeURIComponent(provider)}/${encodeURIComponent(sessionId)}/messages${suffix}`);
  }
  // 会话增量事件：只有 codex 由 Go 承接，调用方负责 Provider 边界。
  function getSessionEvents(provider, sessionId, queryString) {
    const suffix = queryString ? `?${queryString}` : '';
    return call('GET', `/v1/management/webui/sessions/${encodeURIComponent(provider)}/${encodeURIComponent(sessionId)}/events${suffix}`);
  }
  function getGitDiff(projectPath, filePath, staged) {
    const params = new URLSearchParams({ projectPath: String(projectPath || ''), path: String(filePath || '') });
    if (staged) params.set('staged', '1');
    return call('GET', `/v1/management/webui/git/diff?${params.toString()}`);
  }
  function getGitSummary(projectPath) {
    const params = new URLSearchParams({ projectPath: String(projectPath || '') });
    return call('GET', `/v1/management/webui/git/summary?${params.toString()}`);
  }
  function getSessionPreviews(sessions) {
    return call('POST', '/v1/management/webui/sessions/previews', { sessions: Array.isArray(sessions) ? sessions : [] });
  }
  function getToolkitEnvironments() {
    return call('GET', '/v1/management/webui/toolkit/environments');
  }
  function getProjects() {
    return call('GET', '/v1/management/webui/projects');
  }
  // 单项目完整会话集合：projectPath 原样交给 Go 归一化，Node 只在 Go 不可用或
  // 查不到项目（手动打开/远程工作区等 Go 不覆盖的入口）时回退本地实现。
  function getProjectSessions(projectPath) {
    const params = new URLSearchParams({ projectPath: String(projectPath || '') });
    return call('GET', `/v1/management/webui/projects/sessions?${params.toString()}`);
  }
  // 项目级运行态 SSE：事件源在 Go 进程内（fsnotify + run/provider-session-state），
  // Node 只把字节流透传给浏览器，不再自己轮询项目快照。
  async function watchProjects() {
    const controller = new AbortController();
    try {
      const response = await fetchImpl(baseUrl + '/v1/management/webui/projects/watch', {
        method: 'GET',
        headers: { authorization: 'Bearer ' + managementKey, accept: 'text/event-stream' },
        signal: controller.signal
      });
      return {
        ok: response.ok,
        status: response.status,
        body: response.body,
        abort: () => controller.abort()
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        body: null,
        errorCode: error && error.name === 'AbortError' ? 'aborted' : 'network_error',
        abort: () => controller.abort()
      };
    }
  }
  function requestProjectsSnapshot() {
    return call('POST', '/v1/management/webui/projects/watch/snapshot', {});
  }
  // 账号页实时视图：快照、revision 与增量 diff 都在 Go；Node 只透传字节流。
  async function watchAccounts() {
    const controller = new AbortController();
    // SSE 是长连接：本地 Go Core 必须绕过出站代理，否则代理会把 loopback
    // 流断开成 network_error（普通请求有回退，长连接没有）。
    const loopback = /^http:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/)/.test(baseUrl);
    const streamBase = loopback ? baseUrl.replace('://0.0.0.0:', '://127.0.0.1:') : baseUrl;
    const streamFetch = loopback && typeof globalThis.fetch === 'function' ? globalThis.fetch : fetchImpl;
    try {
      const response = await streamFetch(streamBase + '/v1/management/webui/accounts/watch', {
        method: 'GET',
        headers: { authorization: 'Bearer ' + managementKey, accept: 'text/event-stream' },
        signal: controller.signal
      });
      return {
        ok: response.ok,
        status: response.status,
        body: response.body,
        abort: () => controller.abort()
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        body: null,
        errorCode: error && error.name === 'AbortError' ? 'aborted' : 'network_error',
        abort: () => controller.abort()
      };
    }
  }
  function requestAccountsSnapshot() {
    return call('POST', '/v1/management/webui/accounts/watch/snapshot', {});
  }
  // 本机账号扫描：Go 承接路由与契约，扫描执行走 Node 内部宿主能力端点。
  // 单独用 120s 超时：家族凭据解密要拉起厂商 Electron（冷启动约 4.5s/个），
  // 默认 30s 会把一次正常扫描截断成 go_core_timeout。
  async function detectHostAccounts() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const response = await fetchImpl(baseUrl + '/v1/management/webui/accounts/detect', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + managementKey, 'content-type': 'application/json' },
        body: '{}',
        signal: controller.signal
      });
      const raw = await response.text();
      let json = null;
      try { json = raw ? JSON.parse(raw) : null; } catch (_error) {}
      return {
        ok: response.ok && json && json.ok === true,
        status: response.status,
        data: json
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        data: null,
        errorCode: error && error.name === 'AbortError' ? 'go_core_timeout' : 'go_core_unreachable'
      };
    } finally {
      clearTimeout(timer);
    }
  }
  function getSshReverseTunnels() {
    return call('GET', '/v1/management/webui/ssh/reverse-tunnels');
  }
  function reconcileSshReverseTunnels() {
    return call('POST', '/v1/management/webui/ssh/reverse-tunnels/reconcile', {});
  }
  async function watchSshReverseTunnels() {
    const controller = new AbortController();
    try {
      const response = await fetchImpl(baseUrl + '/v1/management/webui/ssh/reverse-tunnels/watch', {
        method: 'GET',
        headers: { authorization: 'Bearer ' + managementKey, accept: 'text/event-stream' },
        signal: controller.signal
      });
      return {
        ok: response.ok,
        status: response.status,
        body: response.body,
        abort: () => controller.abort()
      };
    } catch (error) {
      return { ok: false, status: 0, body: null, errorCode: error && error.name === 'AbortError' ? 'aborted' : 'network_error', abort: () => controller.abort() };
    }
  }

  function browseSshHost({ connectionId, subDir } = {}) {
    const params = new URLSearchParams();
    params.set('connectionId', String(connectionId || ''));
    if (subDir !== undefined) params.set('subDir', String(subDir || ''));
    return call('GET', `/v1/management/webui/ssh-hosts/browse?${params.toString()}`);
  }

  function commitPluginState(payload) {
    return call('POST', '/v1/management/plugins/state/commit', payload);
  }

  // 插件实例启停：入口在 Go，Go 再回调 Node 的内部 prepare/activate/discard。
  // instanceId 是路径参数；payload 仍是原来的 enable/disable body。
  function enablePlugin(instanceId, payload) {
    return call('POST', `/v1/management/plugins/instances/${encodeURIComponent(String(instanceId || ''))}/enable`, payload);
  }

  function disablePlugin(instanceId, payload) {
    return call('POST', `/v1/management/plugins/instances/${encodeURIComponent(String(instanceId || ''))}/disable`, payload);
  }

  // 应用启动权限设置读模型：设置记录（app-state.db）与 capability/权限目录都由 Go 组装。
  // 写入口仍在 Node（PUT /v0/webui/toolkit/apps/:appId/settings），这条只读。
  function getToolAppSettings(appId) {
    return call('GET', `/v1/management/webui/tool-apps/${encodeURIComponent(String(appId || ''))}/settings`);
  }

  // 模型别名投影：整体替换 Go 的别名表，返回已接受 id 与已应用代次
  // （data.accepted_ids / data.applied_generation）。Go 只接受它能忠实执行的别名。
  function pushModelAliases(aliases) {
    return call('PUT', '/v1/management/model-aliases', { aliases });
  }

  // 只读诊断：查看 Go 当前存储与已应用的别名代次。
  function getModelAliases() {
    return call('GET', '/v1/management/model-aliases');
  }

  // 账号级配置：只推账号自身规则与挂载组 id，有效规则由 Go 拼装。
  function putAccountUpstreamErrorRules(accountRef, payload) {
    return call(
      'PUT',
      '/v1/management/accounts/' + encodeURIComponent(String(accountRef || '')) + '/upstream-error-rules',
      payload
    );
  }

  // 清空账号级配置（Go 侧幂等；账号已删除时返回 deleted:false）。
  function deleteAccountUpstreamErrorRules(accountRef) {
    return call(
      'DELETE',
      '/v1/management/accounts/' + encodeURIComponent(String(accountRef || '')) + '/upstream-error-rules'
    );
  }

  // 全部账号级配置：用于对账与删除 Go 侧已不存在的旧引用。
  function listAccountUpstreamErrorRules() {
    return call('GET', '/v1/management/account-upstream-error-rules');
  }

  // 全局公共模型目录投影：Node 仍拥有远端探测与合并，Go 只接收最近完整快照。
  function pushModelCatalogProjection(payload) {
    return call('PUT', '/v1/management/model-catalog', payload);
  }

  function getModelCatalog() {
    return call('GET', '/v1/management/model-catalog');
  }

  // Go Host authoritative management projections. These are read-only shadow
  // contracts; Node remains the production owner of /v0/management/*.
  function getManagementStatus() {
    return call('GET', '/v1/management/status');
  }

  function getManagementMetrics() {
    return call('GET', '/v1/management/metrics');
  }

  function buildUsageQuery(query = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    const suffix = params.toString();
    return suffix ? `?${suffix}` : '';
  }

  function getUsageStats(query = {}) {
    return call('GET', `/v1/management/usage/stats${buildUsageQuery(query)}`);
  }

  function getUsageModels(query = {}) {
    return call('GET', `/v1/management/usage/models${buildUsageQuery(query)}`);
  }

  function getUsageSessions(query = {}) {
    return call('GET', `/v1/management/usage/sessions${buildUsageQuery(query)}`);
  }

  // Go 账号列表使用 after_ref keyset 分页（page.has_more / page.next_after_ref）。
  async function listAccounts() {
    const accounts = [];
    let afterRef = '';
    for (let guard = 0; guard < 10000; guard += 1) {
      const query = afterRef ? `?limit=100&after_ref=${encodeURIComponent(afterRef)}` : '?limit=100';
      const result = await call('GET', `/v1/management/accounts${query}`);
      if (!result.ok) return { ...result, data: accounts };
      for (const item of Array.isArray(result.data) ? result.data : []) accounts.push(item);
      const page = result.page || {};
      if (!page.has_more || !page.next_after_ref) {
        return { ok: true, status: 200, data: accounts, page: null, errorCode: '' };
      }
      afterRef = String(page.next_after_ref);
    }
    return { ok: false, status: 0, data: accounts, page: null, errorCode: 'pagination_runaway' };
  }

  return {
    pushPluginProjection,
    getPluginInventory,
    getPluginTrustedKeys,
    addPluginTrustedKey,
    removePluginTrustedKey,
    installPlugin,
    uninstallPlugin,
    browseSshHost,
    getSlashCommands,
    setWebUIMobile,
    clearWebUIMobile,
    setWebUIDefault,
    clearWebUIDefault,
    startKimiDesktopSession,
    pollKimiDesktopSession,
    getKimiPlanStats,
    updateAccountRoutingRules,
    restoreAccountScheduling,
    runAccountActivity,
    probeAccountActivity,
    getAccountActivityJob,
    listAccountActivityParams,
    runAccountActivityForAccount,
    getSessionMessages,
    getSessionEvents,
    getGitDiff,
    getGitSummary,
    getSessionPreviews,
    getToolkitEnvironments,
    getProjects,
    getProjectSessions,
    watchProjects,
    requestProjectsSnapshot,
    getSshReverseTunnels,
    reconcileSshReverseTunnels,
    watchSshReverseTunnels,
    commitPluginState,
    enablePlugin,
    disablePlugin,
    getToolAppSettings,
    pushModelAliases,
    getModelAliases,
    putAccountUpstreamErrorRules,
    deleteAccountUpstreamErrorRules,
    listAccountUpstreamErrorRules,
    pushModelCatalogProjection,
    getModelCatalog,
    getManagementStatus,
    getManagementMetrics,
    getUsageStats,
    getUsageModels,
    getUsageSessions,
    // 账号额度重置历史：数据源是 Node 的 app-state.db，Go 只读；ref 必须原样传
    // Node 账号引用（事件与 account_refs 都按它写入），不做 Go ref 翻译。
    // 别名自动选号池的只读设置（写入口仍在 Node）。
    getAccountAliasPool: (provider, accountRef) => call(
      'GET',
      '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
        '/' + encodeURIComponent(accountRef) + '/alias-pool'
    ),
    // 写入别名池参与开关：Go 是 app_kv 的写者，Node 只做运行池重载。
    setAccountAliasPool: (provider, accountRef, participates) => call(
      'POST',
      '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
        '/' + encodeURIComponent(accountRef) + '/alias-pool',
      { participates: participates === true }
    ),
    // 宿主机入口可用性探测：PATH / 安装落点 / .app bundle 的实测结论由 Go 产出，
    // Node 只补静态能力声明与运行中实例。refresh=1 跳过 Go 的 30s 进程缓存。
    getAppEntries: (refresh) => call(
      'GET',
      '/v1/management/webui/app-entries' + (refresh ? '?refresh=1' : '')
    ),
    // 打开应用：Provider/账号校验与启动计划由 Go 判定；返回体是 Go 的计算结果。
    openAccountApp: (provider, accountRef, payload) => call(
      'POST',
      '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
        '/' + encodeURIComponent(accountRef) + '/open-app',
      payload && typeof payload === 'object' ? payload : {}
    ),
    // 认证来源链：installable / alreadyImported / 排序分组由 Go 装配，Node 只做形状校验
    // （见 webui-account-routes 的 readGoProviderAuthSources）与插件来源兜底。
    getProviderAuthSources: (provider) => call(
      'GET',
      '/v1/management/webui/accounts/provider-auth-sources?provider=' + encodeURIComponent(provider)
    ),
    // 会话框大段粘贴阈值：Go 只读 app-state.db 的 config:server（与 CLI 同键）。
    getChatPasteSettings: () => call('GET', '/v1/management/webui/chat/paste-settings'),    // 写入大段粘贴阈值：Go 在立即事务里只合并 largePasteChars。
    updateChatPasteSettings: (payload) => call('POST', '/v1/management/webui/chat/paste-settings', payload),
    // provider CLI 升级账本：Go 读 run/provider-cli-upgrade.json 并投影。
    getProviderCliUpgrade: () => call('GET', '/v1/management/webui/provider-cli-upgrade'),
    // 解除升级熔断：账本校验与写回都在 Go；Node 只转发 provider。
    clearProviderCliBroken: (provider) => call(
      'POST',
      '/v1/management/webui/provider-cli-upgrade/' + encodeURIComponent(provider) + '/clear-broken'
    ),
    // Provider Hook 档案：读取投影与显式安装都在 Go；Node 只补 server 侧上下文。
    getProviderHooks: () => call('GET', '/v1/management/webui/provider-hooks'),
    installProviderHooks: (payload) => call('POST', '/v1/management/webui/provider-hooks/install', payload),
    // 控制面 profiles：Go 读写 app-state.db 的 control-plane:profiles。
    getControlPlaneProfiles: () => call('GET', '/v1/management/webui/control-plane/profiles'),
    saveControlPlaneProfile: (payload) => call('POST', '/v1/management/webui/control-plane/profiles', payload),
    setActiveControlPlaneProfile: (profileId) => call('POST', '/v1/management/webui/control-plane/profiles/active', { profileId }),
    removeControlPlaneProfile: (profileId) => call(
      'DELETE',
      '/v1/management/webui/control-plane/profiles/' + encodeURIComponent(profileId)
    ),
    // 控制面端点提示：请求地址/绑定 host/端口由 Node 传入。
    getControlPlaneEndpoints: (params = {}) => {
      const search = new URLSearchParams();
      if (params.endpoint) search.set('endpoint', String(params.endpoint));
      if (params.host) search.set('host', String(params.host));
      if (params.port) search.set('port', String(params.port));
      const query = search.toString();
      return call('GET', '/v1/management/webui/control-plane/endpoints' + (query ? '?' + query : ''));
    },
    // 全局用量配置：Go 读写 app-state.db 的 config:usage。
    getUsageConfig: () => call('GET', '/v1/management/webui/config'),
    setUsageConfig: (config) => call('POST', '/v1/management/webui/config', { config }),
    // SSH 连接列表：Go 只读 app-state.db 的 ssh_connections 并脱敏。
    getSshConnections: () => call('GET', '/v1/management/webui/ssh-connections'),
    // SSH 工作区列表：Go 只读 ssh_workspaces 并补远端影子目录。
    getSshWorkspaces: () => call('GET', '/v1/management/webui/ssh-workspaces'),
    // SSH 工作区终端状态：Go 读工作区并探测自己的 tmux 会话。
    getSshWorkspaceSessions: () => call('GET', '/v1/management/webui/ssh-workspaces/sessions'),
    // server 配置公开视图：Go 只读 config:server 并隐藏密钥。
    getServerConfig: () => call('GET', '/v1/management/webui/server-config'),
    // server 配置写入：Go 合并 patch 后整份写回 config:server。
    setServerConfig: (patch) => call('POST', '/v1/management/webui/server-config', { config: patch }),
    // toolkit 执行目标：Go 只读 ssh_connections 并组装 local + ssh 目标。
    getToolkitTargets: () => call('GET', '/v1/management/webui/toolkit/environments/targets'),
    // 账号配置文件查看：Go 读凭据记录与投影文件，默认脱敏。
    getAccountConfigFiles: (provider, accountRef, mode = 'redacted') => call(
      'GET',
      '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
        '/' + encodeURIComponent(accountRef) + '/config-files' +
        (mode === 'raw' ? '?mode=raw' : '')
    ),
    // 账号 × 模型上下文窗口：Go 读覆盖 + 探测快照 + models.dev 目录。
    getAccountModelContext: (provider, accountRef, models = '') => {
      const params = new URLSearchParams();
      if (String(models || '').trim()) params.set('models', String(models).trim());
      const search = params.toString();
      return call(
        'GET',
        '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
          '/' + encodeURIComponent(accountRef) + '/model-context' +
          (search ? '?' + search : '')
      );
    },
    // 单账号写入上下文窗口：Go 是覆盖表唯一写者。
    setAccountModelContext: (provider, accountRef, payload) => call(
      'POST',
      '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
        '/' + encodeURIComponent(accountRef) + '/model-context',
      payload
    ),
    // 批量写入同 provider 多个账号。
    setAccountModelContextBulk: (provider, payload) => call(
      'POST',
      '/v1/management/webui/accounts/' + encodeURIComponent(provider) + '/model-context/bulk',
      payload
    ),
    // DELETE 清空别名：与 POST tokens=null 同义。
    clearAccountModelContext: (provider, accountRef, model) => call(
      'DELETE',
      '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
        '/' + encodeURIComponent(accountRef) + '/model-context?model=' + encodeURIComponent(String(model || '').trim())
    ),
    // 账号出口绑定：Go 是设置的唯一写者（account:egress:<ref> + 分配投影），
    // Node 只按返回的规范记录做运行态应用与回滚。
    getAccountEgress: (provider, accountRef) => call(
      'GET',
      '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
        '/' + encodeURIComponent(accountRef) + '/egress'
    ),
    saveAccountEgress: (provider, accountRef, payload) => call(
      'POST',
      '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
        '/' + encodeURIComponent(accountRef) + '/egress',
      payload || {}
    ),
    // 窗口激活设置：Go 读写 app_kv 配置与账本，Node 只合并全局调度器状态。
    getWindowActivation: (provider, accountRef) => call(
      'GET',
      '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
        '/' + encodeURIComponent(accountRef) + '/window-activation'
    ),
    saveWindowActivationConfig: (provider, accountRef, payload) => call(
      'POST',
      '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
        '/' + encodeURIComponent(accountRef) + '/window-activation',
      payload
    ),
    getAccountQuotaResetEvents: (provider, accountRef, query = {}) => {
      const params = new URLSearchParams();
      if (query.limit) params.set('limit', String(query.limit));
      if (query.beforeId) params.set('beforeId', String(query.beforeId));
      const search = params.toString();
      return call(
        'GET',
        '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
          '/' + encodeURIComponent(accountRef) + '/quota-reset-events' + (search ? '?' + search : '')
      );
    },
    send: (request) => call(request.method, request.path, request.body),
    getAccount: (accountRef) => call('GET', `/v1/management/accounts/${encodeURIComponent(accountRef)}`),
    setEnabled: (accountRef, enabled) => call('PATCH', `/v1/management/accounts/${encodeURIComponent(accountRef)}`, { enabled }),
    // 账号启停的 WebUI 写入口：Go 同时更新 accounts.enabled 与 account_state 投影。
    setAccountStatus: (provider, accountRef, status) => call(
      'POST',
      '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
        '/' + encodeURIComponent(accountRef) + '/status',
      { status }
    ),
    deleteAccount: (accountRef) => call('DELETE', `/v1/management/accounts/${encodeURIComponent(accountRef)}`),
    setProviderDefault: (providerId, accountRef) => call('PUT', `/v1/management/account-defaults/${encodeURIComponent(providerId)}`, { account_ref: accountRef }),
    clearProviderDefault: (providerId) => call('DELETE', `/v1/management/account-defaults/${encodeURIComponent(providerId)}`),
    getProviderDefault: (providerId) => call('GET', `/v1/management/account-defaults/${encodeURIComponent(providerId)}`),
    setModelPolicy: (accountRef, modelId, manualPolicy) => call('PATCH', `/v1/management/accounts/${encodeURIComponent(accountRef)}/models`, { model_id: modelId, manual_policy: manualPolicy }),
    // 账号结果时间桶（账号页状态条）：granularity = day | hour。
    listAccountOutcomes: (granularity, fromMs) => call('GET', `/v1/management/account-outcomes?granularity=${encodeURIComponent(granularity)}&from_ms=${Math.max(0, Math.floor(Number(fromMs) || 0))}`),
    // 账号当前运行态（硬阻塞 / 模型 cooldown / 最近结果），账号页调度状态叠加层用。
    listAccountRuntime: () => call('GET', '/v1/management/account-runtime'),
    // 完整 Provider 额度快照文档：Go 是存储真相，Node 只做采集与读缓存。
    putUsageDocument: (accountRef, document) => call('PUT', `/v1/management/accounts/${encodeURIComponent(accountRef)}/usage-document`, document),
    getUsageDocument: (accountRef) => call('GET', `/v1/management/accounts/${encodeURIComponent(accountRef)}/usage-document`),
    listUsageDocuments: () => call('GET', '/v1/management/account-usage-documents'),
    // Go 里的归一化额度事实（窗口/剩余/可用性）：Node 用它判断哪些快照还没归一化。
    listAccountUsage: () => call('GET', '/v1/management/account-usage'),
    // Go 派生的账号级额度状态（含 codex Team/Free 的 pending 语义），账号页只做展示叠加。
    listAccountQuotaStates: () => call('GET', '/v1/management/account-quota-states'),
    // 账号页展示状态：Node 是写方，Go 持久化。
    putUIState: (accountRef, state) => call('PUT', `/v1/management/accounts/${encodeURIComponent(accountRef)}/ui-state`, state),
    listUIStates: () => call('GET', '/v1/management/account-ui-states'),
    // 账号级运行态文档：Node 事件转移后写入完整 runtime_state，Go 存储并派生状态与阻塞。
    putRuntimeState: (accountRef, state, updatedAt) => call(
      'PUT',
      `/v1/management/accounts/${encodeURIComponent(accountRef)}/runtime-state`,
      { state, updated_at: String(Math.max(0, Math.floor(Number(updatedAt) || 0))) }
    ),
    deleteRuntimeState: (accountRef, updatedAt) => call(
      'PUT',
      `/v1/management/accounts/${encodeURIComponent(accountRef)}/runtime-state`,
      { state: null, updated_at: String(Math.max(0, Math.floor(Number(updatedAt) || 0))) }
    ),
    listRuntimeStates: () => call('GET', '/v1/management/account-runtime-states'),
    // 成功尝试的 token 用量事件（按序号增量），计入账号 Token 用量。
    listAccountUsageEvents: (afterSeq) => call('GET', `/v1/management/account-usage-events?after_seq=${Math.max(0, Math.floor(Number(afterSeq) || 0))}`),
    // OAuth Job 公开快照：Node 是登录执行者，Go 只负责跨重启持久化与查询。
    putOAuthJob: (record) => call('PUT', `/v1/management/oauth-jobs/${encodeURIComponent(record.job_id)}`, record),
    // Go 承接 OAuth 登录时的三段调用（zcode 固定 / codex 实验开关；Begin / Callback / Cancel）。
    // PKCE verifier 与 state 只存在于 Go 进程内，这里只传公开输入。
    startAccountAuthJob: (payload) => call('POST', '/v1/management/account-auth-jobs', payload),
    completeAccountAuthJob: (jobId, callback) => call(
      'POST',
      `/v1/management/account-auth-jobs/${encodeURIComponent(String(jobId || ''))}/callback`,
      { callback }
    ),
    cancelAccountAuthJob: (jobId) => call(
      'DELETE',
      `/v1/management/account-auth-jobs/${encodeURIComponent(String(jobId || ''))}`
    ),
    // Go 承接的原地重新认证：路径里的 accountRef 必须是 Go 侧引用，调用方负责翻译。
    reauthAccount: (provider, accountRef) => call(
      'POST',
      '/v1/management/webui/accounts/' + encodeURIComponent(provider) +
        '/' + encodeURIComponent(accountRef) + '/reauth',
      {}
    ),
    // Go 承接的新增账号 OAuth 作业：作业状态与换码在 Go，Node 只做 loopback 捕获、
    // 本机来源导入与 CLI 安装确认。返回值形状与本文件的其它 call 相同。
    startAddAccountJob: (payload) => call('POST', '/v1/management/webui/account-add', payload),
    getAddAccountJob: (jobId) => call(
      'GET',
      '/v1/management/webui/account-add/jobs/' + encodeURIComponent(String(jobId || ''))
    ),
    completeAddAccountJob: (jobId, callbackUrl) => call(
      'POST',
      '/v1/management/webui/account-add/jobs/' + encodeURIComponent(String(jobId || '')) + '/callback',
      { callbackUrl: String(callbackUrl || '') }
    ),
    cancelAddAccountJob: (jobId) => call(
      'POST',
      '/v1/management/webui/account-add/jobs/' + encodeURIComponent(String(jobId || '')) + '/cancel',
      {}
    ),
    importAddAccountJob: (jobId, sourceId) => call(
      'POST',
      '/v1/management/webui/account-add/jobs/' + encodeURIComponent(String(jobId || '')) + '/local-import',
      { sourceId: String(sourceId || '') }
    ),
    confirmAddAccountJobInstall: (jobId) => call(
      'POST',
      '/v1/management/webui/account-add/jobs/' + encodeURIComponent(String(jobId || '')) + '/install',
      {}
    ),
    // 账号导入作业：上传负载原样转发，作业状态机、文档解析与逐条导入都在 Go；
    // Node 只做协议外壳（鉴权、体积上限、转发），不再自己排队执行导入。
    startAccountImportJob: (body) => call(
      'POST',
      '/v1/management/webui/account-import',
      String(body || '')
    ),
    getAccountImportJob: (jobId) => call(
      'GET',
      '/v1/management/webui/account-import/jobs/' + encodeURIComponent(String(jobId || ''))
    ),
    // 账号导出：Go 生成的字节、Content-Disposition 与计数响应头都要原样交给浏览器，
    // 因此单独走一次 raw fetch，不解析成 JSON 再序列化。
    exportAccountsDocument: async (query) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      const suffix = String(query || '').replace(/^\?/, '');
      try {
        const response = await fetchImpl(
          `${baseUrl}/v1/management/webui/accounts/export${suffix ? `?${suffix}` : ''}`,
          {
            method: 'GET',
            headers: { authorization: `Bearer ${managementKey}` },
            signal: controller.signal
          }
        );
        const raw = Buffer.from(await response.arrayBuffer());
        let errorCode = '';
        if (!response.ok) {
          try {
            const body = JSON.parse(raw.toString('utf8'));
            const error = body && body.error;
            errorCode = error && typeof error === 'object' ? String(error.code || '') : '';
          } catch (_error) {}
        }
        return {
          ok: response.ok,
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: raw,
          errorCode: errorCode || (response.ok ? '' : `http_${response.status}`)
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          headers: {},
          body: null,
          errorCode: error && error.name === 'AbortError' ? 'timeout' : 'network_error'
        };
      } finally {
        clearTimeout(timer);
      }
    },
    // OAuth Job 快照 SSE：Go 是作业真相源，Node 只消费状态变化并翻译成
    // /v0/webui/accounts/watch 的 auth-job 事件；不做轮询。
    watchAccountAuthJob: async (jobId) => {
      const controller = new AbortController();
      try {
        const response = await fetchImpl(
          baseUrl + '/v1/management/account-auth-jobs/' + encodeURIComponent(String(jobId || '')) + '/watch',
          {
            method: 'GET',
            headers: { authorization: 'Bearer ' + managementKey, accept: 'text/event-stream' },
            signal: controller.signal
          }
        );
        return {
          ok: response.ok,
          status: response.status,
          body: response.body,
          abort: () => controller.abort()
        };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          body: null,
          errorCode: error && error.name === 'AbortError' ? 'aborted' : 'network_error',
          abort: () => controller.abort()
        };
      }
    },
    getOAuthJob: (jobId) => call('GET', `/v1/management/oauth-jobs/${encodeURIComponent(jobId)}`),
    listOAuthJobs: (activeOnly) => call('GET', `/v1/management/oauth-jobs${activeOnly ? '?active=1' : ''}`),
    listAccounts
  };
}

module.exports = {
  createGoManagementClient
};
