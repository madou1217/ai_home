'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

const LAUNCH_SERVICES_REGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const PBS = '/System/Library/CoreServices/pbs';

/**
 * Keep the macOS Services cache in sync with the bundle we just built.
 *
 * The helper is intentionally generated below AIH_HOME_DIR, so LaunchServices
 * can discover its NSServices metadata but PBS may still retain an older
 * registration from the historical ~/Applications copy.  Refreshing both
 * databases after every build (including a cache hit) makes a newly-added
 * Service visible to already-running hosts without touching their menus.
 */
async function registerMacTranslationServices(appPath, { homeDir = os.homedir(), runImpl = run } = {}) {
  const legacyPath = path.join(homeDir, 'Applications', 'AIH Translation.app');
  try {
    await runImpl(LAUNCH_SERVICES_REGISTER, ['-u', legacyPath]);
  } catch (_error) {
    // The old bundle may already be gone; unregister is best-effort cleanup.
  }
  await runImpl(LAUNCH_SERVICES_REGISTER, ['-f', appPath]);
  await runImpl(PBS, ['-update']);
}

// 一个稳定的 .app 身份用于 macOS 辅助功能授权；源码变化在同目录原子替换可执行文件。
// 不依赖 npm 原生包，也不把构建产物写进仓库或覆盖正在运行的 inode。
// 应用版本：主版本取 package.json，构建号取 native 源码最后一次提交时间（同一提交
// 构建结果一致，不会因为每次构建时间不同而反复重编；没有 git 时退回主版本）。
async function resolveMacTranslationVersion(repoRoot) {
  let shortVersion = '1.0.0';
  try {
    shortVersion = String(JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8')).version || shortVersion);
  } catch (_error) {}
  let buildVersion = shortVersion;
  try {
    const { stdout } = await run('git', ['-C', repoRoot, 'log', '-1', '--format=%cd', '--date=format:%Y%m%d.%H%M',
      '--', 'native/translation', 'native/chat', 'native/desktop', 'lib/desktop/translation'], { timeout: 5000 });
    const stamp = String(stdout || '').trim();
    if (/^\d{8}\.\d{4}$/.test(stamp)) buildVersion = stamp;
  } catch (_error) {}
  return { shortVersion, buildVersion, displayVersion: `${shortVersion} (${buildVersion})` };
}

// 由 1024px 品牌图生成标准 .icns（Finder / Dock / 系统设置列表都读 CFBundleIconFile）。
// 只依赖系统自带的 sips + iconutil；失败时返回 null，应用仍可运行，只是没有图标。
async function buildMacTranslationIcns(logoPath, outputPath) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aih-translation-icon-'));
  const iconset = path.join(workDir, 'AppIcon.iconset');
  try {
    await fs.mkdir(iconset);
    const sizes = [16, 32, 128, 256, 512];
    for (const size of sizes) {
      for (const scale of [1, 2]) {
        const pixels = size * scale;
        const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`;
        await run('/usr/bin/sips', ['-z', String(pixels), String(pixels), logoPath, '--out', path.join(iconset, name)], { timeout: 15000 });
      }
    }
    await run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', outputPath], { timeout: 15000 });
    return outputPath;
  } catch (_error) {
    return null;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function buildMacTranslationExecutable(aiHomeDir, { mode = 'helper' } = {}) {
  const sourceDir = path.resolve(__dirname, '../../../native/translation');
  const chatSourceDir = path.resolve(__dirname, '../../../native/chat');
  const desktopSourceDir = path.resolve(__dirname, '../../../native/desktop');
  const sourceFiles = [
    [sourceDir, 'SelectedText.swift'],
    [sourceDir, 'TranslationPanelContent.swift'],
    [sourceDir, 'TranslationPanel.swift'],
    [sourceDir, 'TranslationSettingsWindow.swift'],
    [chatSourceDir, 'ChatPanelContent.swift'],
    [chatSourceDir, 'ChatPanel.swift'],
    [desktopSourceDir, 'ShortcutRegistry.swift'],
    [sourceDir, 'main.swift']
  ];
  const repoRoot = path.resolve(__dirname, '../../..');
  const logoSourcePath = path.join(repoRoot, 'assets/brand/ai-home-app-icon.png');
  const logoBytes = await fs.readFile(logoSourcePath);
  const version = await resolveMacTranslationVersion(repoRoot);
  const sourceBytes = await Promise.all(sourceFiles.map(([directory, name]) => fs.readFile(path.join(directory, name))));
  // Keep generated bundle metadata in the rebuild key as well as Swift
  // sources.  Service registration is part of the helper's runtime contract;
  // changing NSServices must replace an old bundle even when Swift is byte
  // identical.
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.aihome.translation</string>
<key>CFBundleName</key><string>AIH Translation</string>
<key>CFBundleExecutable</key><string>aih-translation</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleDisplayName</key><string>AIH Translation</string>
<key>CFBundleShortVersionString</key><string>${version.shortVersion}</string>
<key>CFBundleVersion</key><string>${version.buildVersion}</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleIconName</key><string>AppIcon</string>
<key>NSHumanReadableCopyright</key><string>AI Home</string>
<key>LSUIElement</key>${mode === 'full-app' ? '<false/>' : '<true/>'}
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSServices</key><array><dict>
<key>NSMenuItem</key><dict><key>default</key><string>AIH 翻译选中内容</string></dict>
<key>NSMessage</key><string>translateSelectedText</string>
<key>NSPortName</key><string>AIH Translation</string>
<key>NSRequiredContext</key><dict/>
<key>NSSendTypes</key><array><string>public.utf8-plain-text</string><string>public.plain-text</string><string>NSStringPboardType</string></array>
</dict>
<dict>
<key>NSMenuItem</key><dict><key>default</key><string>AIH Chat 选中内容</string></dict>
<key>NSMessage</key><string>chatSelectedText</string>
<key>NSPortName</key><string>AIH Translation</string>
<key>NSRequiredContext</key><dict/>
<key>NSSendTypes</key><array><string>public.utf8-plain-text</string><string>public.plain-text</string><string>NSStringPboardType</string></array>
</dict>
</array>
</dict></plist>`;
  const hash = crypto.createHash('sha256')
    .update(process.arch)
    .update(mode)
    .update(infoPlist)
    .update(logoBytes)
    .update(Buffer.concat(sourceBytes))
    .digest('hex');
  const contents = path.join(aiHomeDir, 'run', 'desktop-translation', 'AIH Translation.app', 'Contents');
  const executable = path.join(contents, 'MacOS', 'aih-translation');
  const logoPath = path.join(contents, 'Resources', 'ai-home-app-icon.png');
  const icnsPath = path.join(contents, 'Resources', 'AppIcon.icns');
  const stamp = path.join(path.dirname(path.dirname(contents)), 'source.sha256');
  const appPath = path.dirname(contents);
  if (await fs.readFile(stamp, 'utf8').catch(() => '') === hash
      && await fs.readFile(path.join(contents, 'Info.plist'), 'utf8').catch(() => '') === infoPlist
      && (await fs.readFile(logoPath).catch(() => Buffer.alloc(0))).equals(logoBytes)
      && await fs.stat(icnsPath).catch(() => null)) {
    if (await fs.stat(executable).catch(() => null)) {
      await registerMacTranslationServices(appPath);
      return executable;
    }
  }
  await fs.mkdir(path.dirname(executable), { recursive: true });
  const temporary = `${executable}.${process.pid}.tmp`;
  try {
    await run('/usr/bin/xcrun', ['swiftc', '-O', '-o', temporary, ...sourceFiles.map(([directory, name]) => path.join(directory, name)), '-framework', 'AppKit', '-framework', 'ApplicationServices'], { timeout: 120000, maxBuffer: 1024 * 1024 });
    await fs.rename(temporary, executable);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
  await fs.writeFile(path.join(contents, 'Info.plist'), infoPlist);
  await fs.mkdir(path.dirname(logoPath), { recursive: true });
  await fs.writeFile(logoPath, logoBytes);
  await buildMacTranslationIcns(logoSourcePath, icnsPath);
  // 固定 designated requirement，让同一路径的新构建继续对应同一个授权项。
  await run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.aihome.translation', '-r', '=designated => identifier "com.aihome.translation"', path.dirname(contents)], { timeout: 15000 });
  await fs.writeFile(stamp, hash);
  await registerMacTranslationServices(appPath);
  return executable;
}

// 见 native/translation/disclaim-launcher.c：没有它，helper 的辅助功能权限会被算到
// 拉起它的 node 头上。启动器放在 .app 外面，不改变 bundle 签名，也就不会让已有的
// 授权失效。编译失败时退回直接启动（行为与之前一致）。
async function buildMacDisclaimLauncher(aiHomeDir) {
  const source = path.resolve(__dirname, '../../../native/translation/disclaim-launcher.c');
  const sourceBytes = await fs.readFile(source);
  const hash = crypto.createHash('sha256').update(process.arch).update(sourceBytes).digest('hex');
  const dir = path.join(aiHomeDir, 'run', 'desktop-translation');
  const launcher = path.join(dir, 'aih-disclaim');
  const stamp = path.join(dir, 'aih-disclaim.sha256');
  if (await fs.readFile(stamp, 'utf8').catch(() => '') === hash && await fs.stat(launcher).catch(() => null)) {
    return launcher;
  }
  await fs.mkdir(dir, { recursive: true });
  const temporary = `${launcher}.${process.pid}.tmp`;
  try {
    await run('/usr/bin/xcrun', ['clang', '-O2', '-o', temporary, source], { timeout: 60000, maxBuffer: 1024 * 1024 });
    await fs.rename(temporary, launcher);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
  await fs.writeFile(stamp, hash);
  return launcher;
}

async function buildMacTranslationHelper(aiHomeDir) {
  const executable = await buildMacTranslationExecutable(aiHomeDir, { mode: 'helper' });
  try {
    const launcher = await buildMacDisclaimLauncher(aiHomeDir);
    return { command: launcher, args: [executable] };
  } catch (_error) {
    return executable;
  }
}

async function buildMacTranslationApp(aiHomeDir) {
  return buildMacTranslationExecutable(aiHomeDir, { mode: 'full-app' });
}

module.exports = {
  resolveMacTranslationVersion,
  buildMacTranslationExecutable,
  buildMacTranslationHelper,
  buildMacTranslationApp,
  buildMacDisclaimLauncher,
  registerMacTranslationServices
};
