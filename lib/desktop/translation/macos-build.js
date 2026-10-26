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
    .update(Buffer.concat(sourceBytes))
    .digest('hex');
  const contents = path.join(aiHomeDir, 'run', 'desktop-translation', 'AIH Translation.app', 'Contents');
  const executable = path.join(contents, 'MacOS', 'aih-translation');
  const stamp = path.join(path.dirname(path.dirname(contents)), 'source.sha256');
  const appPath = path.dirname(contents);
  if (await fs.readFile(stamp, 'utf8').catch(() => '') === hash
      && await fs.readFile(path.join(contents, 'Info.plist'), 'utf8').catch(() => '') === infoPlist) {
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
  // 固定 designated requirement，让同一路径的新构建继续对应同一个授权项。
  await run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.aihome.translation', '-r', '=designated => identifier "com.aihome.translation"', path.dirname(contents)], { timeout: 15000 });
  await fs.writeFile(stamp, hash);
  await registerMacTranslationServices(appPath);
  return executable;
}

async function buildMacTranslationHelper(aiHomeDir) {
  return buildMacTranslationExecutable(aiHomeDir, { mode: 'helper' });
}

async function buildMacTranslationApp(aiHomeDir) {
  return buildMacTranslationExecutable(aiHomeDir, { mode: 'full-app' });
}

module.exports = {
  buildMacTranslationExecutable,
  buildMacTranslationHelper,
  buildMacTranslationApp,
  registerMacTranslationServices
};
