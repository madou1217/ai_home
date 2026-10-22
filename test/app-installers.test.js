'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { listProviderDefinitions } = require('../lib/provider-catalog');
const { getAppInstaller, listManagedAppInstallers, INSTALLERS } = require('../lib/server/app-installers');
const {
  buildNpmPlan,
  buildNpmUpdatePlan,
  buildNpmUninstallPlan,
  buildShellPlan
} = require('../lib/server/app-installers/official-install');

test('Codex 安装和更新首选官方脚本，保留完整独立安装包', () => {
  const codex = getAppInstaller('codex');
  for (const platform of ['darwin', 'linux', 'win32']) {
    const options = { platform, kind: 'cli' };
    const install = codex.resolveCliInstallPlans(options);
    const update = codex.resolveLifecyclePlans('update', options);
    const suffix = platform === 'win32' ? 'ps1' : 'sh';
    assert.ok(install[0].args.join(' ').includes(`https://chatgpt.com/codex/install.${suffix}`));
    assert.deepEqual(update[0], install[0]);
    assert.equal(install.at(-1).id, 'npm_global');
  }
});

test('后台 shell 安装计划不读取用户登录配置', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-shell-plan-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(homeDir, '.bash_profile'), 'echo login_profile_loaded >&2\nexit 87\n');
  const plan = buildShellPlan('probe', 'probe', 'printf shell_plan_ok');

  const result = spawnSync(plan.command, plan.args, {
    env: { ...process.env, HOME: homeDir },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'shell_plan_ok');
  assert.doesNotMatch(result.stderr, /login_profile_loaded/);
});

test('每个合同 CLI Provider 都由独立安装器模块提供统一入口', () => {
  const providers = listProviderDefinitions()
    .filter((definition) => definition.clients && definition.clients.cli)
    .map((definition) => definition.id);
  assert.ok(providers.length > 0);
  providers.forEach((provider) => {
    const installer = getAppInstaller(provider);
    assert.ok(installer, `${provider} must have an independent installer module`);
    assert.equal(installer.provider, provider);
    assert.equal(typeof installer.install, 'function');
    assert.equal(typeof installer.update, 'function');
    assert.equal(typeof installer.uninstall, 'function');
    assert.equal(typeof installer.installCli, 'function');
    assert.equal(typeof installer.resolveDesktopInstallPlans, 'function');
  });
  providers.forEach((provider) => assert.ok(Object.prototype.hasOwnProperty.call(INSTALLERS, provider)));
});

test('ZCode 安装器只提供 Desktop 能力，不暴露 CLI 安装入口', () => {
  const zcode = getAppInstaller('zcode');
  assert.ok(zcode);
  assert.equal(typeof zcode.installCli, 'undefined');
  assert.equal(typeof zcode.resolveCliInstallPlans, 'undefined');
  assert.equal(typeof zcode.listCliBinaryNames, 'undefined');
  assert.equal(typeof zcode.resolveDesktopInstallPlans, 'function');
});

test('注册表发现的每个独立 Provider 安装器都实现生命周期接口', () => {
  const installers = Object.values(INSTALLERS);
  assert.ok(installers.length > 0);
  installers.forEach((installer) => {
    assert.equal(typeof installer.install, 'function', `${installer.provider} must implement install()`);
    assert.equal(typeof installer.update, 'function', `${installer.provider} must implement update()`);
    assert.equal(typeof installer.uninstall, 'function', `${installer.provider} must implement uninstall()`);
  });
});

test('独立托管 CLI 不污染 Provider 合同，并通过同一生命周期接口注册', () => {
  const dsh = getAppInstaller('dsh');
  assert.ok(dsh);
  assert.equal(dsh.managedApp.id, 'dsh');
  assert.equal(dsh.managedApp.type, 'cli');
  assert.equal(dsh.listCliBinaryNames()[0], 'dsh');
  assert.deepEqual(listManagedAppInstallers().map((installer) => installer.provider), ['dsh', 'pi']);
  assert.deepEqual(dsh.resolveLifecyclePlans('update', { kind: 'cli' }).map((plan) => plan.id), ['npm_global_update']);
  assert.deepEqual(dsh.resolveLifecyclePlans('uninstall', { kind: 'cli' }).map((plan) => plan.id), ['npm_global_uninstall']);
});

test('桌面安装参数只来自对应 Provider 安装器', () => {
  const codex = getAppInstaller('codex');
  const claude = getAppInstaller('claude');
  const kimi = getAppInstaller('kimi');
  const zcode = getAppInstaller('zcode');
  const gemini = getAppInstaller('gemini');
  const grok = getAppInstaller('grok');

  assert.deepEqual(codex.resolveDesktopInstallPlans({ platform: 'darwin' })[0].args, [
    'install', '--cask', 'chatgpt'
  ]);
  assert.deepEqual(claude.resolveDesktopInstallPlans({ platform: 'win32' })[0].args.slice(0, 4), [
    'install', '--id', 'Anthropic.Claude', '--exact'
  ]);
  // Store 的 ChatGPT 产品 id 是 9PLM9XGG6VKS（PackageFamilyName OpenAI.Codex），
  // 社区源没有 OpenAI.ChatGPT，必须钉住 msstore 源。
  const codexWindows = codex.resolveDesktopInstallPlans({ platform: 'win32' })[0];
  assert.deepEqual(codexWindows.args, [
    'install', '--id', '9PLM9XGG6VKS', '--exact', '--source', 'msstore',
    '--accept-package-agreements', '--accept-source-agreements'
  ]);
  assert.ok(codexWindows.successExitCodes.includes(2316632107));
  assert.equal(kimi.resolveDesktopInstallPlans({
    platform: 'darwin',
    processObj: { platform: 'darwin', arch: 'arm64', env: {} }
  })[0].id, 'kimi_desktop_macos_official');
  assert.equal(kimi.resolveDesktopInstallPlans({
    platform: 'win32',
    processObj: { platform: 'win32', arch: 'x64', env: {} }
  })[0].id, 'kimi_desktop_windows_official');
  assert.equal(zcode.resolveDesktopInstallPlans({ platform: 'darwin' })[0].id, 'zcode_desktop_macos_official_page');
  assert.deepEqual(gemini.resolveDesktopInstallPlans({ platform: 'darwin' }), []);
  assert.deepEqual(grok.resolveDesktopInstallPlans({ platform: 'darwin' }), []);
});

test('Kimi Desktop 安装器从官方动态端点解析白名单 DMG 并精确安装 Kimi.app', () => {
  const kimi = getAppInstaller('kimi');
  const [plan] = kimi.resolveDesktopInstallPlans({
    platform: 'macos',
    processObj: { platform: 'darwin', arch: 'arm64', env: {} }
  });

  assert.equal(plan.command, 'bash');
  const script = plan.args.at(-1);
  assert.match(script, /appsupport\.kimi\.ai\/api\/app\/pkg\/latest\/macos\/download/);
  assert.match(script, /https:\/\/kimi-img\.moonshot\.cn\/\*/);
  assert.match(script, /hdiutil attach .* -readonly /);
  assert.match(script, /CFBundleIdentifier raw/);
  assert.match(script, /com\.moonshot\.kimichat/);
  assert.match(script, /codesign --verify --deep --strict/);
  assert.match(script, /TeamIdentifier/);
  assert.match(script, /2J9472RW75/);
  assert.match(script, /Kimi Installer\.app\/Contents\/Helpers\/Kimi\.app/);
  assert.match(script, /target="\$install_root\/Kimi\.app"/);
  assert.match(script, /ditto "\$app" "\$stage"/);
  assert.match(script, /codesign --verify --deep --strict "\$stage"/);
  assert.match(script, /mv "\$target" "\$backup"/);
  assert.match(script, /mv "\$stage" "\$target"/);
  assert.match(script, /\[ "\$installed" -ne 1 \].*mv "\$backup" "\$target"/);
  assert.match(script, /trap cleanup EXIT/);
});

test('Kimi Desktop Windows 安装器校验官方跳转、Authenticode 与发布者后静默安装', () => {
  const kimi = getAppInstaller('kimi');
  const [plan] = kimi.resolveDesktopInstallPlans({
    platform: 'windows',
    processObj: { platform: 'win32', arch: 'x64', env: { SystemRoot: 'C:\\Windows' } }
  });

  assert.equal(plan.id, 'kimi_desktop_windows_official');
  assert.equal(plan.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const script = plan.args.at(-1);
  assert.match(script, /appsupport\.kimi\.ai\/api\/app\/pkg\/latest\/windows\/download/);
  assert.match(script, /AllowAutoRedirect = \$false/);
  assert.match(script, /kimi-img\.moonshot\.cn/);
  assert.match(script, /\/app\/download\/windows\/kimi_/);
  assert.match(script, /Get-AuthenticodeSignature/);
  assert.match(script, /SignerCertificate/);
  // 官方安装包的证书 Subject 是中文法定名，不含 Moonshot；指纹校验才是语言无关的。
  assert.match(script, /6DA99CCA99A69947C11F97395A55FD2DC683420D/);
  assert.match(script, /Moonshot\|月之暗面/);
  assert.match(script, /Start-Process -FilePath \$dest -ArgumentList @\('\/S'\) -PassThru/);
  // 不能等整棵进程树：安装器会拉起应用，-Wait 会一直卡到应用退出。
  assert.doesNotMatch(script, /-Wait/);
  assert.match(script, /WaitForExit\(1200000\)/);
  assert.match(script, /3010/);
  assert.match(script, /管理员权限/);
  assert.match(script, /Remove-Item -Force \$dest/);
});

test('Windows 官方安装脚本在内存执行，不落临时 .ps1', () => {
  const codex = getAppInstaller('codex');
  const [plan] = codex.resolveCliInstallPlans({ platform: 'win32' });
  const script = plan.args.at(-1);
  assert.match(script, /Invoke-WebRequest -Uri 'https:\/\/chatgpt\.com\/codex\/install\.ps1'/);
  assert.match(script, /\[scriptblock\]::Create\(\$text\)/);
  assert.match(script, /\[System\.Text\.Encoding\]::UTF8\.GetString/);
  // 火绒会把刚下载的 .ps1 隔离成不可读；脚本不应再落到临时文件。
  assert.doesNotMatch(script, /Join-Path \$env:TEMP/);
  assert.doesNotMatch(script, /Get-Command curl\.exe/);
});

test('安装器公共平台接口使用 macos/windows/linux，兼容 Node 别名输入', () => {
  const codex = getAppInstaller('codex');
  const claude = getAppInstaller('claude');
  assert.equal(codex.resolveDesktopInstallPlans({ platform: 'macos' })[0].command, 'brew');
  assert.equal(claude.resolveDesktopInstallPlans({ platform: 'windows' })[0].command, 'winget.exe');
  assert.equal(codex.resolveDesktopInstallPlans({ platform: 'win32' })[0].command, 'winget.exe');
});

test('npm 生命周期计划隔离用户配置并固定公共 registry', () => {
  const packageName = '@example/provider-cli';
  const builders = [
    buildNpmPlan,
    buildNpmUpdatePlan,
    buildNpmUninstallPlan
  ];

  for (const platform of ['macos', 'linux', 'windows']) {
    const expectedUserConfig = platform === 'windows' ? 'NUL' : '/dev/null';
    const expectedCommand = platform === 'windows' ? 'npm.cmd' : 'npm';
    for (const buildPlan of builders) {
      const plan = buildPlan(packageName, { platform });
      assert.equal(plan.command, expectedCommand);
      assert.ok(plan.args.includes(`--userconfig=${expectedUserConfig}`));
      assert.ok(plan.args.includes('--registry=https://registry.npmjs.org'));
    }
  }
});

test('官方安装器优先使用可验证的稳定下载端点，并覆盖 Windows CMD 兜底', () => {
  const agy = getAppInstaller('agy');
  const agyWindowsCli = agy.resolveCliInstallPlans({ platform: 'windows' });
  assert.deepEqual(agyWindowsCli.map((plan) => plan.id), [
    'agy_windows_official',
    'agy_windows_cmd_official'
  ]);
  assert.equal(agyWindowsCli[1].command, 'cmd.exe');
  assert.ok(agyWindowsCli[1].args.at(-1).includes('https://antigravity.google/cli/install.cmd'));

  const claude = getAppInstaller('claude');
  const claudePlans = claude.resolveCliInstallPlans({ platform: 'windows' });
  assert.deepEqual(claudePlans.map((plan) => plan.id), [
    'claude_windows_official',
    'claude_windows_cmd_official',
    'winget'
  ]);
  const claudeCmd = claudePlans.find((plan) => plan.id === 'claude_windows_cmd_official');
  assert.equal(claudeCmd.windowsVerbatimArguments, true);
  assert.deepEqual(claudeCmd.args.slice(0, 3), ['/d', '/s', '/c']);
  // cmd 脚本里的 URL 必须保留双引号；libuv 默认的 \" 转义会让 curl 报端口号错误。
  // 目标文件用字面量 %TEMP%\...（不要 set 变量再 call：展开时机不可靠）。
  assert.match(claudeCmd.args[3], /^"curl\.exe -fsSL "https:\/\/claude\.ai\/install\.cmd" -o "%TEMP%\\aih-installer-claude_windows_cmd_official\.cmd"/);

  const opencode = getAppInstaller('opencode');
  const opencodeWindows = opencode.resolveDesktopInstallPlans({ platform: 'windows' });
  assert.equal(opencodeWindows[0].id, 'opencode_desktop_windows_official');
  assert.match(opencodeWindows[0].args.join(' '), /dev\.opencode\.ai\/download\/stable\/windows-x64-nsis/);
  const opencodeLinux = opencode.resolveDesktopInstallPlans({ platform: 'linux' });
  assert.deepEqual(opencodeLinux.map((plan) => plan.id), [
    'opencode_desktop_linux_deb',
    'opencode_desktop_linux_rpm'
  ]);

  const zcode = getAppInstaller('zcode');
  const zcodeLinux = zcode.resolveDesktopInstallPlans({ platform: 'linux' })[0];
  assert.ok(zcodeLinux.args.join(' ').includes('.AppImage'));
});

test('Desktop 安装器只在官方资料声明的架构上提供计划', () => {
  const x64Mac = { platform: 'macos', processObj: { platform: 'darwin', arch: 'x64', env: {} } };
  assert.deepEqual(getAppInstaller('kimi').resolveDesktopInstallPlans(x64Mac), []);

  const armLinux = { platform: 'linux', processObj: { platform: 'linux', arch: 'arm64', env: {} } };
  assert.deepEqual(getAppInstaller('zcode').resolveDesktopInstallPlans(armLinux), []);
  assert.deepEqual(getAppInstaller('kiro').resolveDesktopInstallPlans(armLinux), []);
  assert.deepEqual(getAppInstaller('opencode').resolveDesktopInstallPlans(armLinux), []);
  assert.deepEqual(getAppInstaller('qoder').resolveDesktopInstallPlans(armLinux), []);
  assert.deepEqual(getAppInstaller('qodercn').resolveDesktopInstallPlans(armLinux), []);

  const armWindows = { platform: 'windows', processObj: { platform: 'win32', arch: 'arm64', env: {} } };
  assert.equal(getAppInstaller('zcode').resolveDesktopInstallPlans(armWindows).length, 1);
  assert.deepEqual(getAppInstaller('kimi').resolveDesktopInstallPlans(armWindows), []);
  assert.deepEqual(getAppInstaller('opencode').resolveDesktopInstallPlans(armWindows), []);

  const x64Windows = { platform: 'windows', processObj: { platform: 'win32', arch: 'x64', env: {} } };
  assert.equal(getAppInstaller('kimi').resolveDesktopInstallPlans(x64Windows).length, 1);
});

test('IDE 应用插件同时声明宿主描述与安装方式，IDE 注册表从插件聚合', () => {
  const { INSTALLERS } = require('../lib/server/app-installers');
  const { listIdeClients, getIdeClient } = require('../lib/cli/services/toolkit/ide-client-registry');
  const declared = Object.values(INSTALLERS).filter((installer) => installer.ideClient).map((installer) => installer.provider);
  assert.deepEqual([...listIdeClients()].sort(), [...declared].sort());
  assert.deepEqual(listIdeClients(), ['vscode', 'cursor', 'windsurf']);
  for (const id of listIdeClients()) {
    const client = getIdeClient(id);
    assert.equal(client, INSTALLERS[id].ideClient);
    assert.equal(typeof INSTALLERS[id].resolveDesktopInstallPlans, 'function');
    assert.ok(client.configDirectoryName);
  }
  assert.equal(typeof INSTALLERS.claude.desktopConfigPath, 'function');
});

function resolveDesktopPlans(provider, platform, arch = 'arm64') {
  return getAppInstaller(provider).resolveDesktopInstallPlans({
    platform,
    processObj: {
      platform: platform === 'windows' ? 'win32' : (platform === 'linux' ? 'linux' : 'darwin'),
      arch,
      env: {}
    }
  });
}

test('macOS Desktop 安装计划回报 DMG 的实际落点，而不是只写进猜测路径', () => {
  for (const provider of ['qoder', 'qodercn', 'kiro', 'kimi', 'agy', 'zcode']) {
    const [plan] = resolveDesktopPlans(provider, 'macos', 'arm64');
    assert.ok(plan, `${provider} 应提供 macOS 安装计划`);
    const script = plan.args.at(-1);
    assert.match(script, /AIH_DESKTOP_INSTALLED_PATH=\$/, `${provider} 必须回报实际安装落点`);
  }
});

test('Qoder 系列安装器对齐官方包名、用户级安装器与静默参数', () => {
  const [qoderMac] = resolveDesktopPlans('qoder', 'macos', 'arm64');
  const qoderMacScript = qoderMac.args.at(-1);
  assert.match(qoderMacScript, /-name 'Qoder IDE\.app'/);
  assert.match(qoderMacScript, /installed="\$HOME\/Applications\/\$\(basename "\$app"\)"/);

  const [qoderCnMac] = resolveDesktopPlans('qodercn', 'macos', 'arm64');
  const qoderCnMacScript = qoderCnMac.args.at(-1);
  assert.match(qoderCnMacScript, /-name 'Qoder CN IDE\.app'/);

  const [qoderWindows] = resolveDesktopPlans('qoder', 'windows', 'x64');
  const qoderWindowsScript = qoderWindows.args.at(-1);
  assert.match(qoderWindowsScript, /QoderIDEUserSetup-x64\.exe/);
  assert.match(qoderWindowsScript, /-ArgumentList @\('\/VERYSILENT', '\/SUPPRESSMSGBOXES', '\/NORESTART', '\/SP-'\)/);

  // 国内站必须使用 UserSetup（用户级，不弹 UAC），而不是机器级 Setup。
  const [qoderCnWindows] = resolveDesktopPlans('qodercn', 'windows', 'x64');
  const qoderCnWindowsScript = qoderCnWindows.args.at(-1);
  assert.match(qoderCnWindowsScript, /QoderCNIDEUserSetup-x64\.exe/);
  assert.doesNotMatch(qoderCnWindowsScript, /QoderCNIDESetup-x64\.exe/);
  assert.match(qoderCnWindowsScript, /-ArgumentList @\('\/VERYSILENT', '\/SUPPRESSMSGBOXES', '\/NORESTART', '\/SP-'\)/);
  assert.match(qoderCnWindowsScript, /-PassThru/);
  assert.match(qoderCnWindowsScript, /3010/);
  assert.match(qoderCnWindowsScript, /管理员权限/);
  // Windows PowerShell 5.1 的 Invoke-WebRequest 下载大安装包会卡死；
  // 有 curl.exe 时优先用它，并保留无 curl 环境的回落。
  assert.match(qoderCnWindowsScript, /Get-Command curl\.exe/);
  assert.match(qoderCnWindowsScript, /--speed-time 60/);
  assert.match(qoderCnWindowsScript, /Invoke-WebRequest/);
  // `if (...) { ... }; else { ... }` 在 PowerShell 里是语法错误（真机踩过）。
  assert.doesNotMatch(qoderCnWindowsScript, /\}\s*;\s*else/);
});

test('Kiro Desktop 从官方 metadata 解析安装包并静默安装', () => {
  const [macPlan] = resolveDesktopPlans('kiro', 'macos', 'arm64');
  const macScript = macPlan.args.at(-1);
  assert.match(macScript, /prod\.download\.desktop\.kiro\.dev\/stable\/metadata-\$target-stable\.json/);
  assert.match(macScript, /dmg-darwin-arm64/);
  assert.doesNotMatch(macScript, /kiro\.dev\/downloads/);

  const [windowsPlan] = resolveDesktopPlans('kiro', 'windows', 'x64');
  const windowsScript = windowsPlan.args.at(-1);
  assert.match(windowsScript, /metadata-win32-\$arch-user-stable\.json/);
  assert.doesNotMatch(windowsScript, /kiro\.dev\/downloads/);
  assert.match(windowsScript, /-ArgumentList @\('\/VERYSILENT', '\/SUPPRESSMSGBOXES', '\/NORESTART', '\/SP-'\)/);
  assert.match(windowsScript, /3010/);
  assert.match(windowsScript, /管理员权限/);
  assert.match(windowsScript, /Get-Command curl\.exe/);
  assert.match(windowsScript, /--speed-time 60/);
});

test('Windows 可执行安装器统一使用静默参数、退出码校验与 UAC 提示', () => {
  const providers = ['opencode', 'zcode', 'agy', 'kimi'];
  for (const provider of providers) {
    const [plan] = resolveDesktopPlans(provider, 'windows', 'x64');
    assert.ok(plan, `${provider} 应提供 Windows 安装计划`);
    const script = plan.args.at(-1);
    assert.match(script, /Start-Process -FilePath \$dest -ArgumentList @\('\/S'\) -PassThru/, provider);
    assert.doesNotMatch(script, /-Wait/, provider);
    assert.match(script, /WaitForExit\(1200000\)/, provider);
    assert.match(script, /3010/, provider);
    assert.match(script, /管理员权限/, provider);
    assert.match(script, /安装器退出码/, provider);
    // 大安装包必须走 curl（Invoke-WebRequest 会卡死），并保留无 curl 时的回落。
    assert.match(script, /Get-Command curl\.exe/, provider);
    assert.match(script, /--speed-time 60/, provider);
    assert.doesNotMatch(script, /\}\s*;\s*else/, provider);
  }
});
