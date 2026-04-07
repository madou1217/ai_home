'use strict';

function createPtyRuntime(options = {}) {
  const {
    path,
    fs,
    processObj,
    pty,
    spawn,
    execSync,
    resolveCliPath,
    buildPtyLaunch,
    resolveWindowsBatchLaunch,
    shouldEnableShellDrawer,
    isShellDrawerToggleSequence,
    resolveShellDrawerLaunch,
    getShellDrawerPtyRows,
    getShellDrawerTotalHeight,
    readUsageConfig,
    cliConfigs,
    aiHomeDir,
    getProfileDir,
    askYesNo,
    stripAnsi,
    ensureSessionStoreLinks,
    ensureUsageSnapshot,
    ensureUsageSnapshotAsync,
    readUsageCache,
    getUsageRemainingPercentValues,
    getNextAvailableId,
    markActiveAccount,
    ensureAccountUsageRefreshScheduler,
    refreshIndexedStateForAccount
  } = options;

  function isUsageManagedCli(cliName) {
    return cliName === 'codex' || cliName === 'gemini' || cliName === 'claude';
  }

  function normalizeLoginForwardArgs(cliName, forwardArgs) {
    const input = Array.isArray(forwardArgs) ? [...forwardArgs] : [];
    const hasNoBrowser = input.some((arg) => String(arg || '').trim() === '--no-browser');
    const args = input.filter((arg) => String(arg || '').trim() !== '--no-browser');
    if (hasNoBrowser && cliName === 'codex' && !args.includes('--device-auth')) {
      args.push('--device-auth');
    }
    return args;
  }

  function normalizeProxyEnv(envObj) {
    const env = { ...(envObj || {}) };
    const keys = [
      ['http_proxy', 'HTTP_PROXY'],
      ['https_proxy', 'HTTPS_PROXY'],
      ['all_proxy', 'ALL_PROXY'],
      ['no_proxy', 'NO_PROXY']
    ];
    keys.forEach(([lower, upper]) => {
      const lowerValue = typeof env[lower] === 'string' ? env[lower].trim() : '';
      const upperValue = typeof env[upper] === 'string' ? env[upper].trim() : '';
      if (lowerValue && !upperValue) env[upper] = lowerValue;
      if (upperValue && !lowerValue) env[lower] = upperValue;
    });
    return env;
  }

  /**
   * 同步宿主的非敏感配置到账号专属配置
   * @param {string} accountConfigPath - 账号配置文件路径
   * @param {string} hostConfigPath - 宿主配置文件路径
   * @param {string} accountId - 账号 ID
   * @param {{fs: any, path: any}} deps - 依赖
   */
  function syncCodexConfigFromHost(accountConfigPath, hostConfigPath, accountId, deps) {
    const { fs, path } = deps;

    // 1. 读取或创建账号配置
    let accountConfig = '';
    let accountLines = [];
    let accountOnlyConfig = {}; // 账号专属配置 (preferred_auth_method, model_provider, providers)

    if (fs.existsSync(accountConfigPath)) {
      accountConfig = fs.readFileSync(accountConfigPath, 'utf8');
      accountLines = accountConfig.split('\n');

      // 提取账号专属配置
      accountOnlyConfig = extractAccountOnlyConfig(accountConfig);
    }

    // 2. 读取宿主配置
    if (!hostConfigPath || !fs.existsSync(hostConfigPath)) {
      // 如果宿主配置不存在,确保账号配置至少有头部
      if (!fs.existsSync(accountConfigPath)) {
        const defaultConfig = '# Codex configuration for account ' + accountId + '\n' +
          '# This file is managed by ai-home (aih)\n' +
          '# Synced from host config (excluding sensitive fields)\n\n';
        fs.writeFileSync(accountConfigPath, defaultConfig, 'utf8');
      }
      return;
    }

    const hostConfig = fs.readFileSync(hostConfigPath, 'utf8');

    // 3. 过滤宿主配置,移除敏感和账号专属字段
    const safeHostConfig = filterHostConfig(hostConfig, {
      excludeAccountOnly: true,  // 排除 preferred_auth_method, model_provider
      excludeSensitive: true      // 排除 bearer_token, api_key 等
    });

    // 4. 合并配置
    const mergedConfig = mergeConfigs(safeHostConfig, accountOnlyConfig, accountId);

    // 5. 写回账号配置
    fs.writeFileSync(accountConfigPath, mergedConfig, 'utf8');
  }

  /**
   * 提取账号专属配置 (preferred_auth_method, model_provider, [[providers]])
   */
  function extractAccountOnlyConfig(configText) {
    const result = {
      preferred_auth_method: null,
      model_provider: null,
      providers: []
    };

    const lines = configText.split('\n');
    let inProviders = false;
    let currentProvider = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // 提取 preferred_auth_method
      if (line.startsWith('preferred_auth_method')) {
        result.preferred_auth_method = line;
      }

      // 提取 model_provider
      if (line.startsWith('model_provider')) {
        result.model_provider = line;
      }

      // 提取 [[providers]]
      if (line === '[[providers]]') {
        inProviders = true;
        currentProvider = [line];
        continue;
      }

      if (inProviders) {
        if (line.startsWith('[[') || line.startsWith('[model_providers') || (line === '' && i + 1 < lines.length && lines[i + 1].trim().startsWith('['))) {
          // 新的 section 开始
          if (currentProvider.length > 0) {
            result.providers.push(currentProvider.join('\n'));
          }
          inProviders = false;
          currentProvider = [];
        } else {
          currentProvider.push(lines[i]); // 保留原始缩进
        }
      }
    }

    // 最后一个 provider
    if (currentProvider.length > 0) {
      result.providers.push(currentProvider.join('\n'));
    }

    return result;
  }

  /**
   * 过滤宿主配置,移除敏感和账号专属字段
   */
  function filterHostConfig(configText, options) {
    const lines = configText.split('\n');
    const filtered = [];
    let skipUntilNextSection = false;
    let inModelProviders = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // 跳过账号专属字段
      if (options.excludeAccountOnly) {
        if (trimmed.startsWith('preferred_auth_method') || trimmed.startsWith('model_provider')) {
          continue;
        }
        // 跳过 [[providers]] section
        if (trimmed === '[[providers]]') {
          skipUntilNextSection = true;
          continue;
        }
      }

      // ✅ 跳过 approvals_reviewer 和 sandbox_mode 字段
      // 这些字段会在 mergeConfigs 中统一设置为 Full Access 模式
      if (trimmed.startsWith('approvals_reviewer') || trimmed.startsWith('sandbox_mode')) {
        continue;
      }

      // 跳过敏感字段
      if (options.excludeSensitive) {
        // 进入 [model_providers.*] section
        if (trimmed.startsWith('[model_providers.')) {
          inModelProviders = true;
          filtered.push(line);
          continue;
        }

        // 离开 [model_providers.*] section
        if (inModelProviders && (trimmed.startsWith('[') && !trimmed.startsWith('[model_providers'))) {
          inModelProviders = false;
        }

        // 在 [model_providers.*] section 中,跳过敏感字段
        if (inModelProviders) {
          if (trimmed.startsWith('bearer_token') || trimmed.startsWith('api_key') || trimmed.includes('_token =') || trimmed.includes('_key =')) {
            continue; // 跳过敏感字段
          }
        }
      }

      // 检查是否到达新 section (结束跳过)
      if (skipUntilNextSection) {
        if (trimmed.startsWith('[') && trimmed !== '[[providers]]') {
          skipUntilNextSection = false;
        } else {
          continue; // 继续跳过
        }
      }

      filtered.push(line);
    }

    return filtered.join('\n');
  }

  /**
   * 合并配置
   */
  function mergeConfigs(hostConfigText, accountOnlyConfig, accountId) {
    const lines = [];

    // 头部
    lines.push('# Codex configuration for account ' + accountId);
    lines.push('# This file is managed by ai-home (aih)');
    lines.push('# Synced from host config (excluding sensitive fields)');
    lines.push('');

    // 账号专属配置放在最前面
    if (accountOnlyConfig.preferred_auth_method) {
      lines.push(accountOnlyConfig.preferred_auth_method);
    }
    if (accountOnlyConfig.model_provider) {
      lines.push(accountOnlyConfig.model_provider);
    }
    lines.push('');

    // ✅ 强制设置权限策略: Full Access + 自动审批
    lines.push('# AI Home managed permissions: Full Access with auto-approval');
    lines.push('sandbox_mode = "danger-full-access"');
    lines.push('approvals_reviewer = "auto"');
    lines.push('');

    // 宿主配置 (已过滤)
    const hostLines = hostConfigText.split('\n');
    let hasContent = false;
    for (const line of hostLines) {
      const trimmed = line.trim();
      // 跳过注释行和头部
      if (trimmed.startsWith('#') && (trimmed.includes('Codex configuration') || trimmed.includes('managed by'))) {
        continue;
      }
      if (trimmed || hasContent) {
        lines.push(line);
        if (trimmed) hasContent = true;
      }
    }

    // 账号专属 providers 放在最后
    if (accountOnlyConfig.providers.length > 0) {
      lines.push('');
      lines.push('# Account-specific providers');
      accountOnlyConfig.providers.forEach((provider) => {
        lines.push(provider);
      });
    }

    return lines.join('\n');
  }

  function getShellDrawerLayout() {
    const totalRows = Math.max(8, Number(processObj.stdout && processObj.stdout.rows) || 24);
    const drawerHeight = typeof getShellDrawerTotalHeight === 'function'
      ? getShellDrawerTotalHeight(processObj)
      : 7;
    const safeDrawerHeight = Math.max(5, Math.min(drawerHeight, totalRows - 3));
    const topBorderRow = Math.max(2, totalRows - safeDrawerHeight + 1);
    const headerRow = topBorderRow + 1;
    const contentTop = headerRow + 1;
    const bottomBorderRow = totalRows;
    const contentBottom = bottomBorderRow - 1;
    return {
      totalRows,
      topBorderRow,
      headerRow,
      contentTop,
      contentBottom,
      bottomBorderRow,
      ptyRows: Math.max(2, contentBottom - contentTop + 1)
    };
  }

  function spawnPty(cliName, cliBin, id, forwardArgs, isLogin) {
    const sandboxDir = getProfileDir(cliName, id);

    let loadedEnv = {};
    const envPath = path.join(sandboxDir, '.aih_env.json');
    if (fs.existsSync(envPath)) {
      try { loadedEnv = JSON.parse(fs.readFileSync(envPath, 'utf8')); } catch (_error) {}
    }

    // ✅ Codex API Key 自动检测和持久化
    // 如果检测到当前环境有 OPENAI_API_KEY,但 .aih_env.json 中没有,则自动保存
    if (cliName === 'codex') {
      const hasApiKeyInProcess = !!(processObj.env.OPENAI_API_KEY && String(processObj.env.OPENAI_API_KEY).trim());
      const hasApiKeyInSaved = !!(loadedEnv.OPENAI_API_KEY && String(loadedEnv.OPENAI_API_KEY).trim());
      const hasBaseUrlInProcess = !!(processObj.env.OPENAI_BASE_URL && String(processObj.env.OPENAI_BASE_URL).trim());

      if (hasApiKeyInProcess && !hasApiKeyInSaved) {
        // 自动保存环境变量到 .aih_env.json
        const envToSave = { ...loadedEnv };
        envToSave.OPENAI_API_KEY = String(processObj.env.OPENAI_API_KEY).trim();
        if (hasBaseUrlInProcess) {
          envToSave.OPENAI_BASE_URL = String(processObj.env.OPENAI_BASE_URL).trim();
        }
        try {
          fs.writeFileSync(envPath, JSON.stringify(envToSave, null, 2), 'utf8');
          loadedEnv = envToSave;
          console.log('\x1b[32m[aih]\x1b[0m Detected OPENAI_API_KEY in environment, saved to account config for persistence.');
        } catch (_error) {
          // 保存失败,继续使用当前环境变量
        }
      }
    }

    const codexConfigDir = path.join(sandboxDir, '.codex');

    // ✅ 确保账号专属的配置目录存在,并同步宿主的非敏感配置
    if (cliName === 'codex') {
      try {
        fs.mkdirSync(codexConfigDir, { recursive: true });

        const accountConfigPath = path.join(codexConfigDir, 'config.toml');
        const hostConfigPath = typeof aiHomeDir === 'string'
          ? path.join(path.dirname(path.dirname(aiHomeDir)), '.codex', 'config.toml')
          : null;

        // ✅ 同步宿主配置到账号配置
        syncCodexConfigFromHost(accountConfigPath, hostConfigPath, id, { fs, path });
      } catch (_error) {
        // 如果创建失败,继续执行(可能权限问题)
      }
    }
    const envOverrides = normalizeProxyEnv({
      ...processObj.env,
      ...loadedEnv,
      HOME: sandboxDir,
      USERPROFILE: sandboxDir,
      CLAUDE_CONFIG_DIR: path.join(sandboxDir, '.claude'),
      CODEX_HOME: codexConfigDir,
      // 确保 Codex 使用账号专属的配置目录
      XDG_CONFIG_HOME: sandboxDir,
      XDG_DATA_HOME: path.join(sandboxDir, '.local', 'share'),
      XDG_STATE_HOME: path.join(sandboxDir, '.local', 'state'),
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(sandboxDir, '.gemini', 'settings.json')
    });

    const argsToRunBase = isLogin
      ? [...(cliConfigs[cliName]?.loginArgs || []), ...normalizeLoginForwardArgs(cliName, forwardArgs)]
      : forwardArgs;
    const argsToRun = Array.isArray(argsToRunBase) ? [...argsToRunBase] : [];
    if (
      cliName === 'codex'
      && !isLogin
      && String(processObj.env.AIH_CODEX_AUTO_SKIP_REPO_CHECK || '0') === '1'
      && !argsToRun.includes('--skip-git-repo-check')
    ) {
      argsToRun.unshift('--skip-git-repo-check');
    }
    const batchLaunch = resolveWindowsBatchLaunch(cliName, cliBin || cliName, envOverrides, processObj.platform);
    const launchBin = batchLaunch.launchBin || cliName;
    Object.assign(envOverrides, batchLaunch.envPatch || {});
    const launch = buildPtyLaunch(launchBin, argsToRun, { platform: processObj.platform });
    return pty.spawn(launch.command, launch.args, {
      name: 'xterm-color',
      cols: processObj.stdout.columns || 80,
      rows: processObj.stdout.rows || 24,
      cwd: processObj.cwd(),
      env: envOverrides
    });
  }

  function spawnShellDrawerPty() {
    const launch = typeof resolveShellDrawerLaunch === 'function'
      ? resolveShellDrawerLaunch(processObj)
      : { command: '/bin/sh', args: [] };
    const layout = getShellDrawerLayout();
    const drawerRows = typeof getShellDrawerPtyRows === 'function'
      ? getShellDrawerPtyRows(processObj)
      : layout.ptyRows;
    return pty.spawn(launch.command, Array.isArray(launch.args) ? launch.args : [], {
      name: 'xterm-color',
      cols: processObj.stdout.columns || 80,
      rows: Math.max(2, Math.min(drawerRows, layout.ptyRows)),
      cwd: processObj.cwd(),
      env: {
        ...processObj.env,
        AIH_SHELL_DRAWER: '1'
      }
    });
  }

  function runCliPty(cliName, initialId, forwardArgs, isLogin = false) {
    let cliPath = resolveCliPath(cliName);
    if (!cliPath) {
      console.log(`\x1b[33m[aih] Native CLI '${cliName}' not found.\x1b[0m`);
      const ans = askYesNo('Do you want to automatically install it via npm?');
      if (ans) {
        const pkg = cliConfigs[cliName].pkg;
        console.log(`\n\x1b[36m[aih]\x1b[0m Installing \x1b[33m${pkg}\x1b[0m...`);
        execSync(`npm install -g ${pkg}`, { stdio: 'inherit' });
        console.log(`\x1b[32m[aih] Successfully installed ${cliName}!\x1b[0m\n`);
      } else {
        processObj.exit(1);
      }
      cliPath = resolveCliPath(cliName);
      if (!cliPath) {
        console.error(`\x1b[31m[aih] ${cliName} is still not in PATH after install.\x1b[0m`);
        processObj.exit(1);
      }
    }

    console.log(`\n\x1b[36m[aih]\x1b[0m 🚀 Running \x1b[33m${cliName}\x1b[0m (Account ID: \x1b[32m${initialId}\x1b[0m) via PTY Sandbox`);
    const initialSessionSync = ensureSessionStoreLinks(cliName, initialId);
    if (initialSessionSync.migrated > 0 || initialSessionSync.linked > 0) {
      console.log(`\x1b[36m[aih]\x1b[0m Session links ready (${cliName}): migrated ${initialSessionSync.migrated}, linked ${initialSessionSync.linked}.`);
    }

    let activeId = String(initialId || '').trim();
    let ptyProc = spawnPty(cliName, cliPath, activeId, forwardArgs, isLogin);
    let usageRefreshInFlight = false;
    let lastUsageRefreshStartAt = 0;
    let lastSessionActivityAt = Date.now();

    const waveFrames = ['.', '..', '...', ' ..', '  .', '   '];
    let waveIdx = 0;
    let hasReceivedData = false;
    const shellDrawerAvailable = typeof shouldEnableShellDrawer === 'function'
      ? shouldEnableShellDrawer(isLogin, forwardArgs, processObj)
      : false;
    let shellDrawerProc = null;
    let shellDrawerVisible = false;
    let shellDrawerBufferedMainOutput = '';
    let shellDrawerDroppedMainOutput = false;
    let shellDrawerStatusSummary = '';

    const waveInterval = setInterval(() => {
      if (!hasReceivedData) {
        processObj.stdout.write(`\r\x1b[36m[aih]\x1b[0m Waiting for ${cliName} to boot${waveFrames[waveIdx++]}\x1b[K`);
        waveIdx %= waveFrames.length;
      }
    }, 200);

    const onResize = () => {
      if (ptyProc) {
        try { ptyProc.resize(processObj.stdout.columns, processObj.stdout.rows); } catch (_error) {}
      }
      if (shellDrawerProc) {
        const layout = getShellDrawerLayout();
        try { shellDrawerProc.resize(processObj.stdout.columns || 80, layout.ptyRows); } catch (_error) {}
      }
      if (shellDrawerVisible) {
        clearShellDrawerRegion();
        applyShellDrawerViewport();
      } else {
        // ✅ 终端尺寸变化时，强制重新渲染状态行（使用新的尺寸）
        lastRenderedStatusLine = '';
        if (canRenderUsageStatusBar()) {
          emitUsageStatus(activeId, { forcePrint: true, forceRefresh: false });
        }
      }
    };
    processObj.stdout.on('resize', onResize);

    const canUseRawMode = !!(processObj.stdin && processObj.stdin.isTTY && typeof processObj.stdin.setRawMode === 'function');
    if (canUseRawMode) {
      processObj.stdin.setRawMode(true);
    }
    processObj.stdin.resume();

    function getPlainTextWidth(text) {
      const normalized = String(text || '');
      let width = 0;
      for (const ch of normalized) {
        const code = ch.codePointAt(0) || 0;
        if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
        width += code > 0xff ? 2 : 1;
      }
      return width;
    }

    function truncatePlainText(text, maxWidth) {
      const normalized = String(text || '');
      if (maxWidth <= 0) return '';
      let output = '';
      let width = 0;
      for (const ch of normalized) {
        const code = ch.codePointAt(0) || 0;
        const nextWidth = (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) ? 0 : (code > 0xff ? 2 : 1);
        if (width + nextWidth > maxWidth) break;
        output += ch;
        width += nextWidth;
      }
      return output;
    }

    function padPlainText(text, targetWidth) {
      const normalized = truncatePlainText(text, targetWidth);
      const width = getPlainTextWidth(normalized);
      if (width >= targetWidth) return normalized;
      return `${normalized}${' '.repeat(targetWidth - width)}`;
    }

    function buildShellDrawerHeaderText() {
      const hiddenSuffix = shellDrawerBufferedMainOutput
        ? ` | 主会话后台输出已缓存${shellDrawerDroppedMainOutput ? '（部分截断）' : ''}`
        : '';
      return `[aih] Shell Drawer · Ctrl+Alt+J 收起 · cwd: ${processObj.cwd()}${hiddenSuffix}`;
    }

    function buildShellDrawerTopBorder(width) {
      const safeWidth = Math.max(8, Number(width) || 80);
      const innerWidth = Math.max(2, safeWidth - 2);
      const label = ' Shell Drawer ';
      const labelWidth = Math.min(getPlainTextWidth(label), innerWidth);
      const text = truncatePlainText(label, innerWidth);
      return `┌${text}${'─'.repeat(Math.max(0, innerWidth - labelWidth))}┐`;
    }

    function buildShellDrawerHeaderLine(width) {
      const safeWidth = Math.max(8, Number(width) || 80);
      const innerWidth = Math.max(2, safeWidth - 4);
      return `│ ${padPlainText(buildShellDrawerHeaderText(), innerWidth)} │`;
    }

    function buildShellDrawerBottomBorder(width) {
      const safeWidth = Math.max(8, Number(width) || 80);
      return `└${'─'.repeat(Math.max(2, safeWidth - 2))}┘`;
    }

    function buildShellDrawerStatusLine(width) {
      const safeWidth = Math.max(8, Number(width) || 80);
      const innerWidth = Math.max(2, safeWidth);
      const summary = shellDrawerStatusSummary || lastKnownUsageStatusSummary || `account ${activeId} usage remaining: unknown`;
      return padPlainText(`{ ${summary} }`, innerWidth);
    }

    function clearTerminalRow(row) {
      processObj.stdout.write(`\x1b[${row};1H\x1b[2K`);
    }

    function clearShellDrawerRegion() {
      const layout = getShellDrawerLayout();
      clearTerminalRow(Math.max(1, layout.topBorderRow - 1));
      for (let row = layout.topBorderRow; row <= layout.bottomBorderRow; row += 1) {
        clearTerminalRow(row);
      }
    }

    function writeShellDrawerFrame() {
      if (!shellDrawerVisible) return;
      const layout = getShellDrawerLayout();
      const width = processObj.stdout.columns || 80;
      processObj.stdout.write('\x1b7');
      processObj.stdout.write(`\x1b[${Math.max(1, layout.topBorderRow - 1)};1H\x1b[2K${buildShellDrawerStatusLine(width)}`);
      processObj.stdout.write(`\x1b[${layout.topBorderRow};1H\x1b[2K${buildShellDrawerTopBorder(width)}`);
      processObj.stdout.write(`\x1b[${layout.headerRow};1H\x1b[2K${buildShellDrawerHeaderLine(width)}`);
      processObj.stdout.write(`\x1b[${layout.bottomBorderRow};1H\x1b[2K${buildShellDrawerBottomBorder(width)}`);
      processObj.stdout.write('\x1b8');
    }

    function focusShellDrawerCursor() {
      if (!shellDrawerVisible) return;
      const layout = getShellDrawerLayout();
      processObj.stdout.write(`\x1b[${layout.contentTop};1H`);
    }

    function applyShellDrawerViewport() {
      if (!shellDrawerVisible) return;
      const layout = getShellDrawerLayout();
      processObj.stdout.write(`\x1b[${layout.contentTop};${layout.contentBottom}r`);
      writeShellDrawerFrame();
    }

    function flushShellDrawerBufferedMainOutput() {
      if (!shellDrawerBufferedMainOutput) return;
      const bufferedOutput = shellDrawerBufferedMainOutput;
      const hadDroppedOutput = shellDrawerDroppedMainOutput;
      shellDrawerBufferedMainOutput = '';
      shellDrawerDroppedMainOutput = false;
      processObj.stdout.write('\x1b[r');
      processObj.stdout.write('\r\n');
      if (hadDroppedOutput) {
        processObj.stdout.write('\x1b[33m[aih] Shell Drawer 期间主会话输出过多，已截断最早部分内容。\x1b[0m\r\n');
      }
      processObj.stdout.write(bufferedOutput);
    }

    function ensureShellDrawerProc() {
      if (shellDrawerProc) return shellDrawerProc;
      shellDrawerProc = spawnShellDrawerPty();
      shellDrawerProc.onData((data) => {
        if (!shellDrawerVisible) return;
        processObj.stdout.write(data);
        writeShellDrawerFrame();
      });
      shellDrawerProc.onExit(() => {
        shellDrawerProc = null;
        if (!shellDrawerVisible || cleanedUp) return;
        shellDrawerVisible = false;
        processObj.stdout.write('\x1b[r');
        clearShellDrawerRegion();
        processObj.stdout.write('\r\n\x1b[33m[aih] Shell Drawer 已退出，回到主会话。\x1b[0m\r\n');
        flushShellDrawerBufferedMainOutput();
      });
      return shellDrawerProc;
    }

    function openShellDrawer() {
      if (!shellDrawerAvailable || shellDrawerVisible) return false;
      clearUsageStatusLine();
      shellDrawerVisible = true;
      shellDrawerStatusSummary = lastKnownUsageStatusSummary || `account ${activeId} usage remaining: unknown`;
      clearShellDrawerRegion();
      applyShellDrawerViewport();
      ensureShellDrawerProc();
      if (shellDrawerProc) {
        const layout = getShellDrawerLayout();
        try { shellDrawerProc.resize(processObj.stdout.columns || 80, layout.ptyRows); } catch (_error) {}
      }
      focusShellDrawerCursor();
      return true;
    }

    function closeShellDrawer() {
      if (!shellDrawerVisible) return false;
      shellDrawerVisible = false;
      processObj.stdout.write('\x1b[r');
      clearTerminalRow(Math.max(1, getShellDrawerLayout().topBorderRow - 1));
      clearShellDrawerRegion();
      processObj.stdout.write(`\x1b[${Math.max(1, Number(processObj.stdout.rows) || 1)};1H`);
      flushShellDrawerBufferedMainOutput();
      emitUsageStatus(activeId, { forcePrint: true, forceRefresh: false });
      return true;
    }

    function toggleShellDrawer() {
      if (!shellDrawerAvailable) return false;
      if (shellDrawerVisible) return closeShellDrawer();
      return openShellDrawer();
    }

    function isWslPlatform() {
      if (processObj.platform !== 'linux') return false;
      return Boolean(processObj.env.WSL_DISTRO_NAME || processObj.env.WSL_INTEROP);
    }

    function canBridgeWindowsClipboard() {
      return processObj.platform === 'win32' || isWslPlatform();
    }

    function shellSingleQuote(value) {
      return `'${String(value || '').replace(/'/g, '\'\"\'\"\'')}'`;
    }

    function isClipboardPasteTrigger(data) {
      if (!canBridgeWindowsClipboard()) return false;
      const altVPattern = /^\x1b[vV]$/;
      const altVCsiUPattern = /^\x1b\[(?:86|118);3(?:[:;]\d+)*u$/;
      const altVModifyOtherKeysPattern = /^\x1b\[27;3;(?:86|118)(?:;\d+)*~$/;
      if (Buffer.isBuffer(data)) {
        const text = data.toString('utf8');
        if (altVPattern.test(text)) return true;
        if (altVCsiUPattern.test(text)) return true;
        if (altVModifyOtherKeysPattern.test(text)) return true;
        return false;
      }
      const text = String(data || '');
      if (altVPattern.test(text)) return true;
      if (altVCsiUPattern.test(text)) return true;
      if (altVModifyOtherKeysPattern.test(text)) return true;
      return false;
    }

    function normalizeClipboardImagePath(capturedPath) {
      const trimmed = String(capturedPath || '').trim();
      if (!trimmed) return '';
      if (!isWslPlatform()) return trimmed;
      try {
        const converted = execSync(`wslpath -u ${shellSingleQuote(trimmed)}`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        });
        return String(converted || '').trim() || trimmed;
      } catch (_error) {
        return trimmed;
      }
    }

    function tryCaptureClipboardImagePathOnWindows() {
      if (!canBridgeWindowsClipboard()) return '';
      if (String(processObj.env.AIH_WINDOWS_IMAGE_PASTE || '1') === '0') return '';
      const psScript = [
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        'if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }',
        '$img = [System.Windows.Forms.Clipboard]::GetImage()',
        'if ($null -eq $img) { exit 4 }',
        '$dir = Join-Path $env:TEMP "aih-image-paste"',
        '[System.IO.Directory]::CreateDirectory($dir) | Out-Null',
        '$cutoff = [DateTime]::UtcNow.AddDays(-1)',
        'Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -lt $cutoff } | ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue } catch {} }',
        '$file = Join-Path $dir ("aih_clip_" + [DateTime]::Now.ToString("yyyyMMdd_HHmmss_fff") + ".png")',
        '$img.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)',
        '[System.Windows.Forms.Clipboard]::SetText($file)',
        'Write-Output $file'
      ].join('; ');

      const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
      const powerShellCandidates = isWslPlatform()
        ? ['powershell.exe', 'powershell']
        : ['powershell.exe', 'powershell', 'pwsh.exe', 'pwsh'];
      for (const psCmd of powerShellCandidates) {
        try {
          const stdout = execSync(`${psCmd} -NoProfile -STA -EncodedCommand ${encoded}`, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
          });
          const normalized = normalizeClipboardImagePath(stdout);
          if (normalized) return normalized;
        } catch (_error) {}
      }
      return '';
    }

    const onStdinData = (data) => {
      markSessionActivity();
      if (typeof isShellDrawerToggleSequence === 'function' && isShellDrawerToggleSequence(data)) {
        toggleShellDrawer();
        return;
      }
      if (shellDrawerVisible) {
        if (shellDrawerProc) shellDrawerProc.write(data);
        return;
      }
      if (isClipboardPasteTrigger(data)) {
        const imagePath = tryCaptureClipboardImagePathOnWindows();
        if (imagePath) {
          if (ptyProc) ptyProc.write(imagePath);
          return;
        }
      }
      if (ptyProc) ptyProc.write(data);
    };
    processObj.stdin.on('data', onStdinData);

    let outputBuffer = '';
    let isSwapping = false;
    let thresholdTimer = null;
    let usageDisplayTimer = null;
    let usageIdleStatusTimer = null;
    let lastUsageDisplaySignature = '';
    let idleStatusTick = 0;
    let lastKnownUsageStatusSummary = `account ${activeId} usage remaining: unknown`;
    const idleSleepFrames = ['ZzZZzz', 'zZzZZz', 'zzZzZZ', 'zzzZzZ', 'zzzzZZ', 'zzzZzZ', 'zzZzZZ', 'zZzZZz'];
    const usageRefreshFrames = ['|', '/', '-', '\\'];
    const workingStatusLabel = 'working...';
    const workingComfortMessagesPath = path.join(__dirname, 'working-comfort-messages.json');
    let workingComfortMessagesCache = null;
    let workingComfortMessagesRaw = '';
    let lastComfortBucket = '';
    let lastComfortSlot = -1;
    let lastComfortIndex = -1;
    let clipboardMirrorProc = null;
    let clipboardMirrorRestartTimer = null;
    let clipboardMirrorLockPath = '';
    let clipboardMirrorLockOwned = false;
    let sigintHandler = null;
    let cleanedUp = false;

    function canRenderUsageStatusBar() {
      if (String(processObj.env.AIH_RUNTIME_USAGE_STATUS_BAR || '1') === '0') return false;
      const stdout = processObj.stdout || {};
      const stdin = processObj.stdin || {};
      if (stdout.isTTY === true) return true;
      if (stdin.isTTY === true && Number(stdout.columns) > 0 && Number(stdout.rows) > 0) return true;
      return false;
    }

    function stopUsageRefreshProcess() {
      usageRefreshInFlight = false;
    }

    function getUsageIdlePauseMs() {
      return 5 * 60 * 1000;
    }

    function isUsageRefreshPausedByIdle() {
      return Date.now() - lastSessionActivityAt > getUsageIdlePauseMs();
    }

    function markSessionActivity() {
      const wasIdle = isUsageRefreshPausedByIdle();
      lastSessionActivityAt = Date.now();
      if (wasIdle) {
        emitUsageStatus(activeId, { forcePrint: true, forceRefresh: true, bypassIdleCheck: true });
      }
    }

    async function refreshUsageSnapshotNoCache(cliNameArg, idArg) {
      const cache = readUsageCache(cliNameArg, idArg);
      if (typeof ensureUsageSnapshotAsync === 'function') {
        return ensureUsageSnapshotAsync(cliNameArg, idArg, cache, { forceRefresh: true });
      }
      if (typeof ensureUsageSnapshot === 'function') {
        return ensureUsageSnapshot(cliNameArg, idArg, cache, { forceRefresh: true });
      }
      return cache;
    }

    function stopClipboardMirrorProcess() {
      if (clipboardMirrorRestartTimer) {
        clearTimeout(clipboardMirrorRestartTimer);
        clipboardMirrorRestartTimer = null;
      }
      if (clipboardMirrorProc) {
        const proc = clipboardMirrorProc;
        clipboardMirrorProc = null;
        try { proc.kill(); } catch (_error) {}
      }
      releaseClipboardMirrorLock();
    }

    function isProcessAlive(pid) {
      const safePid = Number(pid);
      if (!Number.isInteger(safePid) || safePid <= 0) return false;
      const killFn = typeof processObj.kill === 'function' ? processObj.kill.bind(processObj) : process.kill.bind(process);
      try {
        killFn(safePid, 0);
        return true;
      } catch (_error) {
        return false;
      }
    }

    function acquireClipboardMirrorLock() {
      if (clipboardMirrorLockOwned) return true;
      const rootDir = path.join(aiHomeDir, 'runtime-locks');
      const lockPath = path.join(rootDir, 'windows-clipboard-mirror.lock');
      try {
        fs.mkdirSync(rootDir, { recursive: true });
      } catch (_error) {
        return false;
      }

      try {
        const fd = fs.openSync(lockPath, 'wx');
        const payload = {
          pid: processObj.pid,
          createdAt: Date.now()
        };
        fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
        fs.closeSync(fd);
        clipboardMirrorLockPath = lockPath;
        clipboardMirrorLockOwned = true;
        return true;
      } catch (_error) {}

      try {
        const raw = String(fs.readFileSync(lockPath, 'utf8') || '').trim();
        const info = raw ? JSON.parse(raw) : null;
        const ownerPid = Number(info && info.pid);
        if (!isProcessAlive(ownerPid)) {
          fs.unlinkSync(lockPath);
          const fd = fs.openSync(lockPath, 'wx');
          const payload = {
            pid: processObj.pid,
            createdAt: Date.now()
          };
          fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
          fs.closeSync(fd);
          clipboardMirrorLockPath = lockPath;
          clipboardMirrorLockOwned = true;
          return true;
        }
      } catch (_error) {}

      return false;
    }

    function releaseClipboardMirrorLock() {
      if (!clipboardMirrorLockOwned || !clipboardMirrorLockPath) return;
      try { fs.unlinkSync(clipboardMirrorLockPath); } catch (_error) {}
      clipboardMirrorLockOwned = false;
      clipboardMirrorLockPath = '';
    }

    function startClipboardImageMirrorProcess() {
      if (!canBridgeWindowsClipboard()) return;
      if (String(processObj.env.AIH_WINDOWS_IMAGE_PASTE || '1') === '0') return;
      const defaultMirror = '0';
      if (String(processObj.env.AIH_WINDOWS_IMAGE_CLIPBOARD_MIRROR || defaultMirror) !== '1') return;
      if (isLogin) return;
      if (Array.isArray(forwardArgs) && forwardArgs.length > 0) return;
      if (typeof spawn !== 'function') return;
      // Cross-instance singleton: only one mirror poller should watch global clipboard.
      if (!acquireClipboardMirrorLock()) return;

      const wslMode = isWslPlatform();
      const ownerPid = processObj.platform === 'win32' ? Number(processObj.pid) : 0;
      const psScript = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        `$ownerPid = ${Number.isInteger(ownerPid) && ownerPid > 0 ? ownerPid : 0}`,
        '$allowedPidMap = @{}',
        '$allowedPidRefreshAt = [DateTime]::MinValue',
        'Add-Type -Namespace AihNative -Name User32 -MemberDefinition \'[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out int lpdwProcessId);\'',
        'function Update-AihAllowedPidMap {',
        '  $script:allowedPidMap = @{}',
        '  if ($ownerPid -le 0) { return }',
        '  $currentPid = [int]$ownerPid',
        '  for ($i = 0; $i -lt 16 -and $currentPid -gt 0; $i++) {',
        '    $script:allowedPidMap[[string]$currentPid] = $true',
        '    $proc = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $currentPid) -ErrorAction SilentlyContinue',
        '    if ($null -eq $proc) { break }',
        '    $parentPid = [int]$proc.ParentProcessId',
        '    if ($parentPid -le 0 -or $parentPid -eq $currentPid) { break }',
        '    $currentPid = $parentPid',
        '  }',
        '  $script:allowedPidRefreshAt = [DateTime]::UtcNow.AddSeconds(2)',
        '}',
        'function Test-AihForegroundWindow {',
        '  if ($ownerPid -le 0) { return $true }',
        '  if ([DateTime]::UtcNow -ge $script:allowedPidRefreshAt -or $script:allowedPidMap.Count -eq 0) { Update-AihAllowedPidMap }',
        '  if ($script:allowedPidMap.Count -eq 0) { return $false }',
        '  $hwnd = [AihNative.User32]::GetForegroundWindow()',
        '  if ($hwnd -eq [System.IntPtr]::Zero) { return $false }',
        '  $foregroundPid = 0',
        '  [void][AihNative.User32]::GetWindowThreadProcessId($hwnd, [ref]$foregroundPid)',
        '  if ($foregroundPid -le 0) { return $false }',
        '  return $script:allowedPidMap.ContainsKey([string][int]$foregroundPid)',
        '}',
        '$pendingImage = $false',
        '$pendingSince = [DateTime]::UtcNow',
        `$wslMode = $${wslMode ? 'true' : 'false'}`,
        'while ($true) {',
        '  try {',
        '    if (-not (Test-AihForegroundWindow)) {',
        '      $pendingImage = $false',
        '      Start-Sleep -Milliseconds 60',
        '      continue',
        '    }',
        '    if ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
        '      if (-not $pendingImage) {',
        '        $pendingImage = $true',
        '      }',
        '      $pendingSince = [DateTime]::UtcNow',
        '    }',
        '    if ($pendingImage) {',
        '      $handled = $false',
        '      if ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
        '        $img = [System.Windows.Forms.Clipboard]::GetImage()',
        '        if ($null -ne $img) {',
        '          $dir = Join-Path $env:TEMP "aih-image-paste"',
        '          [System.IO.Directory]::CreateDirectory($dir) | Out-Null',
        '          $cutoff = [DateTime]::UtcNow.AddDays(-1)',
        '          Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -lt $cutoff } | ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue } catch {} }',
        '          $file = Join-Path $dir ("aih_clip_" + [DateTime]::Now.ToString("yyyyMMdd_HHmmss_fff") + ".png")',
        '          $img.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)',
        '          if ($wslMode) {',
        '            if ($file -match "^[A-Za-z]:\\\\") {',
        '              $drive = $file.Substring(0, 1).ToLower()',
        '              $rest = $file.Substring(2).Replace("\\\\", "/")',
        '              $pastePath = "/mnt/" + $drive + $rest',
        '            } else {',
        '              $pastePath = $file',
        '            }',
        '            [System.Windows.Forms.Clipboard]::SetText($pastePath)',
        '          } else {',
        '            [System.Windows.Forms.Clipboard]::SetText($file)',
        '          }',
        '          $handled = $true',
        '        }',
        '      }',
        '      if ($handled) {',
        '        $pendingImage = $false',
        '      } else {',
        '        $ageMs = ([DateTime]::UtcNow - $pendingSince).TotalMilliseconds',
        '        if ($ageMs -gt 3000) { $pendingImage = $false }',
        '      }',
        '    }',
        '  } catch {}',
        '  Start-Sleep -Milliseconds 30',
        '}'
      ].join('; ');

      const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
      const candidates = wslMode
        ? ['powershell.exe', 'powershell']
        : ['powershell.exe', 'powershell', 'pwsh.exe', 'pwsh'];

      const scheduleMirrorRestart = () => {
        if (cleanedUp) return;
        if (clipboardMirrorRestartTimer) return;
        clipboardMirrorRestartTimer = setTimeout(() => {
          clipboardMirrorRestartTimer = null;
          trySpawn(0);
        }, 1200);
        if (clipboardMirrorRestartTimer && typeof clipboardMirrorRestartTimer.unref === 'function') {
          clipboardMirrorRestartTimer.unref();
        }
      };

      const trySpawn = (index) => {
        if (index >= candidates.length) {
          releaseClipboardMirrorLock();
          return;
        }
        if (cleanedUp) return;
        const cmd = candidates[index];
        let child = null;
        try {
          child = spawn(cmd, ['-NoProfile', '-STA', '-EncodedCommand', encoded], {
            cwd: processObj.cwd(),
            env: { ...processObj.env },
            stdio: ['ignore', 'ignore', 'ignore']
          });
        } catch (_error) {
          trySpawn(index + 1);
          return;
        }
        if (!child || typeof child.on !== 'function') {
          trySpawn(index + 1);
          return;
        }
        let resolved = false;
        child.on('spawn', () => {
          resolved = true;
          clipboardMirrorProc = child;
        });
        child.on('error', () => {
          if (clipboardMirrorProc === child) clipboardMirrorProc = null;
          if (!resolved) {
            trySpawn(index + 1);
            return;
          }
          releaseClipboardMirrorLock();
          scheduleMirrorRestart();
        });
        child.on('exit', () => {
          if (clipboardMirrorProc === child) clipboardMirrorProc = null;
          if (!resolved) {
            trySpawn(index + 1);
            return;
          }
          releaseClipboardMirrorLock();
          scheduleMirrorRestart();
        });
      };

      trySpawn(0);
    }

    function getUsageDisplayIntervalMs() {
      return Math.max(15_000, Number(processObj.env.AIH_RUNTIME_USAGE_DISPLAY_INTERVAL_MS) || 60_000);
    }

    function getUsageStaleMs() {
      return Math.max(60_000, Number(processObj.env.AIH_RUNTIME_USAGE_STALE_MS) || 300_000);
    }

    function shouldShowUsageInPty() {
      const enabled = String(processObj.env.AIH_RUNTIME_SHOW_USAGE || '1') !== '0';
      const interactive = !isLogin && (!Array.isArray(forwardArgs) || forwardArgs.length === 0);
      return enabled && interactive && isUsageManagedCli(cliName);
    }

    function buildUsageStatusFromCache(cache) {
      const capturedAt = Number(cache && cache.capturedAt);
      const safeCapturedAt = Number.isFinite(capturedAt) && capturedAt > 0 ? capturedAt : null;
      const values = getUsageRemainingPercentValues(cache);
      if (!values.length) {
        return {
          remainingPct: null,
          capturedAt: safeCapturedAt
        };
      }
      return {
        remainingPct: Math.min(...values),
        capturedAt: safeCapturedAt
      };
    }

    function refreshUsageInBackgroundIfStale(id, cache) {
      const capturedAt = Number(cache && cache.capturedAt);
      const stale = !cache || !Number.isFinite(capturedAt) || capturedAt <= 0 || (Date.now() - capturedAt > getUsageStaleMs());
      if (stale) {
        tryRefreshUsageSnapshotInBackground(id);
      }
    }

    function buildUsageStatusSummary(status, id) {
      const accountId = String(id || '').trim();
      if (!Number.isFinite(status && status.remainingPct)) {
        return `account ${accountId} usage remaining: unknown`;
      }
      return `account ${accountId} usage remaining: ${status.remainingPct.toFixed(1)}%`;
    }

    function formatUsageStatusLine(status, id) {
      const summary = buildUsageStatusSummary(status, id);
      if (!Number.isFinite(status && status.remainingPct)) {
        return `\x1b[90m[aih]\x1b[0m ${summary} (snapshot pending)`;
      }
      const stamp = status.capturedAt
        ? new Date(status.capturedAt).toLocaleTimeString('zh-CN', { hour12: false })
        : 'unknown';
      return `\x1b[90m[aih]\x1b[0m ${summary} (updated ${stamp})`;
    }

    let lastRenderedStatusLine = '';

    function writeUsageStatusLine(lineText) {
      if (shellDrawerVisible) return;
      const text = String(lineText || '');
      const canRenderFixedRow = canRenderUsageStatusBar();
      if (!canRenderFixedRow) {
        processObj.stdout.write(`\r\n${text}\r\n`);
        lastRenderedStatusLine = '';
        return;
      }

      // ✅ 防止闪烁：只有内容真正变化时才重绘
      if (text === lastRenderedStatusLine) {
        return;
      }
      lastRenderedStatusLine = text;

      // ✅ 使用实际行数，并根据终端宽度截断内容
      const rows = Math.max(1, Number(processObj.stdout.rows) || 24);
      const cols = Math.max(20, Number(processObj.stdout.columns) || 80);

      // 移除 ANSI 转义码计算实际文本长度
      const stripped = stripAnsi(text);
      const textWidth = getPlainTextWidth(stripped);

      // 如果文本超宽，截断并添加省略号
      let displayText = text;
      if (textWidth > cols) {
        // 保留 ANSI 颜色代码，只截断可见文本
        const maxPlainWidth = cols - 3; // 为 "..." 留空间
        const truncatedPlain = truncatePlainText(stripped, maxPlainWidth);
        // 简化处理：直接使用截断后的纯文本 + 省略号
        displayText = `${truncatedPlain}...`;
      }

      // Save cursor -> move to last row -> clear row -> print status -> restore cursor.
      processObj.stdout.write(`\x1b[s\x1b[${rows};1H\x1b[2K${displayText}\x1b[u`);
    }

    function clearUsageStatusLine() {
      const canRenderFixedRow = canRenderUsageStatusBar();
      if (!canRenderFixedRow) return;
      const rows = Math.max(1, Number(processObj.stdout.rows) || 24);
      processObj.stdout.write(`\x1b[s\x1b[${rows};1H\x1b[2K\x1b[u`);
      lastRenderedStatusLine = '';
    }

    function getComfortBucket(now) {
      const hour = now.getHours();
      if (hour < 6) return 'night';
      if (hour < 9) return 'dawn';
      if (hour < 12) return 'morning';
      if (hour < 14) return 'noon';
      if (hour < 19) return 'afternoon';
      if (hour < 23) return 'evening';
      return 'night';
    }

    function loadWorkingComfortMessages() {
      try {
        if (!fs.existsSync(workingComfortMessagesPath)) {
          workingComfortMessagesRaw = '';
          workingComfortMessagesCache = null;
          return workingComfortMessagesCache;
        }
        const raw = String(fs.readFileSync(workingComfortMessagesPath, 'utf8') || '');
        if (!raw || raw === workingComfortMessagesRaw) {
          return raw ? workingComfortMessagesCache : null;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
          workingComfortMessagesRaw = raw;
          workingComfortMessagesCache = null;
          return workingComfortMessagesCache;
        }
        workingComfortMessagesRaw = raw;
        workingComfortMessagesCache = parsed;
      } catch (_error) {
        workingComfortMessagesRaw = '';
        workingComfortMessagesCache = null;
      }
      return workingComfortMessagesCache;
    }

    function hashComfortSlot(input) {
      let hash = 2166136261;
      const text = String(input || '');
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return hash >>> 0;
    }

    function getWorkingComfortMessage() {
      const now = new Date();
      const bucket = getComfortBucket(now);
      const workingComfortMessages = loadWorkingComfortMessages();
      const messages = workingComfortMessages && (workingComfortMessages[bucket] || workingComfortMessages.afternoon);
      const rotateMs = 60_000;
      if (!Array.isArray(messages) || messages.length === 0) {
        return '';
      }
      const slot = Math.floor(Date.now() / rotateMs);
      if (
        bucket === lastComfortBucket
        && slot === lastComfortSlot
        && lastComfortIndex >= 0
        && lastComfortIndex < messages.length
      ) {
        return messages[lastComfortIndex] || messages[0] || '';
      }
      let nextIndex = hashComfortSlot(`${bucket}:${slot}`) % messages.length;
      if (
        bucket === lastComfortBucket
        && messages.length > 1
        && nextIndex === lastComfortIndex
      ) {
        nextIndex = (nextIndex + 1) % messages.length;
      }
      lastComfortBucket = bucket;
      lastComfortSlot = slot;
      lastComfortIndex = nextIndex;
      return messages[lastComfortIndex] || messages[0] || '';
    }

    function formatIdleStatusLine() {
      const sleepFrame = idleSleepFrames[idleStatusTick % idleSleepFrames.length];
      return `\x1b[90m[aih]\x1b[0m sleeping... ${sleepFrame}`;
    }

    function buildWorkingSuffix() {
      const comfortMessage = getWorkingComfortMessage();
      return comfortMessage
        ? `${workingStatusLabel} ${comfortMessage}`
        : workingStatusLabel;
    }

    function formatRefreshingStatusLine(id) {
      const spinner = usageRefreshFrames[idleStatusTick % usageRefreshFrames.length];
      const targetId = String(id || activeId || '').trim();
      return `\x1b[90m[aih]\x1b[0m account ${targetId} usage remaining refreshing: ${spinner}% | ${buildWorkingSuffix()}`;
    }

    function formatPlayStatusLine() {
      return `\x1b[90m[aih]\x1b[0m ${lastKnownUsageStatusSummary} | ${buildWorkingSuffix()}`;
    }

    function startUsageIdleStatusWatcher() {
      if (!shouldShowUsageInPty()) return;
      if (usageIdleStatusTimer) return;
      usageIdleStatusTimer = setInterval(() => {
        if (cleanedUp || isSwapping || !ptyProc) return;
        idleStatusTick += 1;
        if (usageRefreshInFlight) {
          writeUsageStatusLine(formatRefreshingStatusLine(activeId));
          return;
        }
        if (isUsageRefreshPausedByIdle()) {
          writeUsageStatusLine(formatIdleStatusLine());
          return;
        }
        writeUsageStatusLine(formatPlayStatusLine());
      }, 900);
      if (usageIdleStatusTimer && typeof usageIdleStatusTimer.unref === 'function') {
        usageIdleStatusTimer.unref();
      }
    }

    function emitUsageStatus(id, options = {}) {
      if (shellDrawerVisible) return;
      if (!shouldShowUsageInPty()) return;
      const forcePrint = !!options.forcePrint;
      const forceRefresh = !!options.forceRefresh;
      const bypassIdleCheck = !!options.bypassIdleCheck;
      if (!bypassIdleCheck && isUsageRefreshPausedByIdle()) {
        idleStatusTick += 1;
        writeUsageStatusLine(formatIdleStatusLine());
        return;
      }
      const targetId = String(id || activeId || '').trim();
      if (!/^\d+$/.test(targetId)) return;
      const cache = readUsageCache(cliName, targetId);
      if (forceRefresh) {
        tryRefreshUsageSnapshotInBackground(targetId);
      } else {
        refreshUsageInBackgroundIfStale(targetId, cache);
      }
      if (usageRefreshInFlight) {
        idleStatusTick += 1;
        writeUsageStatusLine(formatRefreshingStatusLine(targetId));
        return;
      }
      const status = buildUsageStatusFromCache(cache);
      lastKnownUsageStatusSummary = buildUsageStatusSummary(status, targetId);
      shellDrawerStatusSummary = lastKnownUsageStatusSummary;
      const remainingSignature = Number.isFinite(status.remainingPct) ? status.remainingPct.toFixed(3) : 'na';
      const signature = `${targetId}|${status.capturedAt || 0}|${remainingSignature}`;
      if (!forcePrint && signature === lastUsageDisplaySignature) return;
      lastUsageDisplaySignature = signature;
      writeUsageStatusLine(`${formatUsageStatusLine(status, targetId)} | ${buildWorkingSuffix()}`);
    }

    function tryRefreshUsageSnapshotInBackground(id) {
      if (!isUsageManagedCli(cliName)) return;
      if (typeof ensureUsageSnapshot !== 'function' && typeof ensureUsageSnapshotAsync !== 'function') return;
      if (usageRefreshInFlight) return;
      const minIntervalMs = Math.max(30_000, Number(processObj.env.AIH_RUNTIME_USAGE_REFRESH_MIN_MS) || 60_000);
      const now = Date.now();
      if (now - lastUsageRefreshStartAt < minIntervalMs) return;
      const targetId = String(id || '').trim();
      if (!/^\d+$/.test(targetId)) return;

      lastUsageRefreshStartAt = now;
      usageRefreshInFlight = true;
      Promise.resolve()
        .then(() => refreshUsageSnapshotNoCache(cliName, targetId))
        .catch(() => null)
        .finally(() => {
          usageRefreshInFlight = false;
          if (!cleanedUp) emitUsageStatus(targetId, { forcePrint: true });
        });
    }

    function cleanupTerminalHooks() {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(waveInterval);
      try { processObj.stdout.off('resize', onResize); } catch (_error) {}
      try { processObj.stdin.off('data', onStdinData); } catch (_error) {}
      if (sigintHandler) {
        try { processObj.off('SIGINT', sigintHandler); } catch (_error) {}
      }
      try { processObj.stdin.pause(); } catch (_error) {}
      if (canUseRawMode) {
        try { processObj.stdin.setRawMode(false); } catch (_error) {}
      }
      if (usageDisplayTimer) {
        clearInterval(usageDisplayTimer);
        usageDisplayTimer = null;
      }
      if (usageIdleStatusTimer) {
        clearInterval(usageIdleStatusTimer);
        usageIdleStatusTimer = null;
      }
      stopClipboardMirrorProcess();
      stopUsageRefreshProcess();
      shellDrawerVisible = false;
      processObj.stdout.write('\x1b[r');
      clearShellDrawerRegion();
      if (shellDrawerProc) {
        try { shellDrawerProc.kill(); } catch (_error) {}
        shellDrawerProc = null;
      }
      clearUsageStatusLine();
    }

    function getThresholdPct() {
      const cfg = readUsageConfig({ filePath: path.join(aiHomeDir, 'usage-config.json') });
      const val = Number(cfg && cfg.threshold_pct);
      if (!Number.isFinite(val)) return 95;
      return Math.max(1, Math.min(100, Math.floor(val)));
    }

    function getCurrentRemainingPct(id) {
      const cache = readUsageCache(cliName, id);
      const capturedAt = Number(cache && cache.capturedAt);
      const stale = !cache || !Number.isFinite(capturedAt) || capturedAt <= 0 || (Date.now() - capturedAt > getUsageStaleMs());
      if (stale) {
        refreshUsageInBackgroundIfStale(id, cache);
        return null;
      }
      const status = buildUsageStatusFromCache(cache);
      return status.remainingPct;
    }

    function switchToAccount(targetId, reasonLabel) {
      const nextId = String(targetId || '').trim();
      if (!/^\d+$/.test(nextId) || nextId === activeId || !ptyProc || isSwapping) return;
      isSwapping = true;
      const fromId = activeId;
      processObj.stdout.write(`\r\n\x1b[33m[aih] ${reasonLabel}. Auto-switch: ${fromId} -> ${nextId}\x1b[0m\r\n`);
      activeId = nextId;
      lastUsageDisplaySignature = '';
      try { ptyProc.kill(); } catch (_error) {}
      setTimeout(() => {
        ptyProc = spawnPty(cliName, cliPath, activeId, forwardArgs, isLogin);
        attachOnData(ptyProc);
        emitUsageStatus(activeId, { forcePrint: true, forceRefresh: true });
        isSwapping = false;
      }, 250);
    }

    function startThresholdWatcher() {
      const enabled = String(processObj.env.AIH_RUNTIME_AUTO_SWITCH || '1') !== '0';
      const interactive = !isLogin && (!Array.isArray(forwardArgs) || forwardArgs.length === 0);
      if (!enabled || !interactive || cliName !== 'codex') return;
      const intervalMs = Math.max(30_000, Number(processObj.env.AIH_RUNTIME_THRESHOLD_CHECK_MS) || 60_000);
      thresholdTimer = setInterval(() => {
        if (isSwapping || !ptyProc) return;
        if (isUsageRefreshPausedByIdle()) return;
        const remaining = getCurrentRemainingPct(activeId);
        if (!Number.isFinite(remaining)) return;
        const usagePct = Math.max(0, Math.min(100, 100 - remaining));
        const thresholdPct = getThresholdPct();
        if (usagePct < thresholdPct) return;
        const nextId = getNextAvailableId(cliName, activeId);
        if (!nextId || String(nextId) === activeId) {
          processObj.stdout.write(`\r\n\x1b[90m[aih] usage ${remaining.toFixed(1)}% remaining (>= threshold hit), no eligible standby account.\x1b[0m\r\n`);
          return;
        }
        switchToAccount(nextId, `usage threshold reached (${remaining.toFixed(1)}% remaining)`);
      }, intervalMs);
      if (thresholdTimer && typeof thresholdTimer.unref === 'function') thresholdTimer.unref();
    }

    function stopThresholdWatcher() {
      if (thresholdTimer) {
        clearInterval(thresholdTimer);
        thresholdTimer = null;
      }
    }

    function startUsageDisplayWatcher() {
      if (!shouldShowUsageInPty()) return;
      emitUsageStatus(activeId, { forcePrint: true, forceRefresh: true });
      usageDisplayTimer = setInterval(() => {
        if (isSwapping || !ptyProc) return;
        emitUsageStatus(activeId, { forcePrint: true, forceRefresh: true });
      }, getUsageDisplayIntervalMs());
      if (usageDisplayTimer && typeof usageDisplayTimer.unref === 'function') usageDisplayTimer.unref();
    }

    function attachOnData(proc) {
      proc.onData((data) => {
        markSessionActivity();
        if (!hasReceivedData) {
          hasReceivedData = true;
          clearInterval(waveInterval);
          processObj.stdout.write('\r\x1b[K');
        }

        if (shellDrawerVisible) {
          shellDrawerBufferedMainOutput += data;
          if (shellDrawerBufferedMainOutput.length > 120000) {
          shellDrawerBufferedMainOutput = shellDrawerBufferedMainOutput.slice(-120000);
          shellDrawerDroppedMainOutput = true;
        }
          writeShellDrawerFrame();
        } else {
          processObj.stdout.write(data);
        }
        outputBuffer += stripAnsi(data);
        if (outputBuffer.length > 1000) outputBuffer = outputBuffer.slice(-1000);

        const lowerOut = outputBuffer.toLowerCase();
        if (isLogin && (lowerOut.includes('failed to login') || lowerOut.includes('socket disconnected') || lowerOut.includes('connection error'))) {
          outputBuffer = '';
          processObj.stdout.write('\r\n\x1b[33m[aih] Detected Network/Auth Error. Attempting to auto-restart the auth process...\x1b[0m\r\n');
          isSwapping = true;
          proc.kill();
          setTimeout(() => {
            isSwapping = false;
            ptyProc = spawnPty(cliName, cliPath, activeId, [], true);
            attachOnData(ptyProc);
          }, 1500);
        }
      });

      proc.onExit(({ exitCode }) => {
        if (!isSwapping) {
          if (isLogin && exitCode === 0) {
            stopThresholdWatcher();
            cleanupTerminalHooks();
            console.log('\n\x1b[32m[aih] Auth completed! Booting standard session...\x1b[0m');
            setTimeout(() => {
              runCliPty(cliName, activeId, forwardArgs, false);
            }, 500);
          } else {
            stopThresholdWatcher();
            cleanupTerminalHooks();
            processObj.stdout.write('\r\n');
            processObj.exit(exitCode || 0);
          }
        }
      });
    }

    attachOnData(ptyProc);
    startClipboardImageMirrorProcess();
    startThresholdWatcher();
    startUsageIdleStatusWatcher();
    startUsageDisplayWatcher();

    sigintHandler = () => {
      stopThresholdWatcher();
      cleanupTerminalHooks();
      processObj.exit(0);
    };
    processObj.on('SIGINT', sigintHandler);
  }

  function runCliPtyTracked(cliName, id, forwardArgs, isLogin) {
    markActiveAccount(cliName, id);
    if (String(processObj.env.AIH_RUNTIME_ENABLE_USAGE_SCHEDULER || '0') === '1') {
      ensureAccountUsageRefreshScheduler();
    }
    refreshIndexedStateForAccount(cliName, id, { refreshSnapshot: false });
    return runCliPty(cliName, id, forwardArgs, isLogin);
  }

  return {
    runCliPtyTracked
  };
}

module.exports = {
  createPtyRuntime
};
