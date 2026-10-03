'use strict';

const { CLIENT_PLATFORMS } = require('../../../../runtime/client-platform');
const { execCommand, parseHttpUrl } = require('./mirror-command');

const ALL = Object.freeze([CLIENT_PLATFORMS.MACOS, CLIENT_PLATFORMS.WINDOWS, CLIENT_PLATFORMS.LINUX]);
const POSIX = Object.freeze([CLIENT_PLATFORMS.MACOS, CLIENT_PLATFORMS.LINUX]);
const WINDOWS = Object.freeze([CLIENT_PLATFORMS.WINDOWS]);

const PRESETS = Object.freeze([
  {
    id: 'npmmirror',
    name: '淘宝源 (npmmirror)',
    url: 'https://registry.npmmirror.com/',
    official: false,
    speed: '国内极速',
    desc: '国内主流镜像，阿里云同步，支持 npm / yarn / pnpm 快速下载'
  },
  {
    id: 'npmjs',
    name: '官方源 (npmjs)',
    url: 'https://registry.npmjs.org/',
    official: true,
    speed: '全球官方',
    desc: 'npm 官方主源，包更新最及时，海外或有代理时首选'
  },
  {
    id: 'tencent',
    name: '腾讯云镜像',
    url: 'https://mirrors.cloud.tencent.com/npm/',
    official: false,
    speed: '国内高速',
    desc: '腾讯云内外部加速源，稳定高可用'
  },
  {
    id: 'aliyun',
    name: '阿里云镜像',
    url: 'https://npm.aliyun.com/',
    official: false,
    speed: '国内高速',
    desc: '阿里云自建公共 npm 镜像'
  },
  {
    id: 'huawei',
    name: '华为云镜像',
    url: 'https://repo.huaweicloud.com/repository/npm/',
    official: false,
    speed: '国内高速',
    desc: '华为开源镜像站提供的 npm 缓存镜像'
  }
]);

const GUIDE = Object.freeze({
  title: 'npm / pnpm / yarn 镜像配置命令行指南',
  commands: [
    {
      platform: 'All Platforms (CLI)',
      platforms: ALL,
      label: 'npm 一键设为全局源',
      cmd: 'npm config set registry <URL>'
    },
    {
      platform: 'All Platforms (CLI)',
      platforms: ALL,
      label: 'pnpm 一键设为全局源',
      cmd: 'pnpm config set registry <URL>'
    },
    {
      platform: 'All Platforms (CLI)',
      platforms: ALL,
      label: 'yarn 一键设为全局源',
      cmd: 'yarn config set registry <URL>'
    },
    {
      platform: 'All Platforms (CLI)',
      platforms: ALL,
      label: '单次临时安装使用镜像',
      cmd: 'npm install <package> --registry=<URL>'
    },
    {
      platform: 'macOS / Linux (.npmrc)',
      platforms: POSIX,
      label: '配置文件直接写入',
      cmd: "printf '%s\\n' registry=<URL> >> ~/.npmrc"
    },
    {
      platform: 'Windows (PowerShell)',
      platforms: WINDOWS,
      label: 'PowerShell 写入 .npmrc',
      cmd: 'Add-Content -Path $HOME\\.npmrc -Value ("registry=" + <URL>)'
    }
  ]
});

function read(options = {}) {
  const res = execCommand('npm', ['config', 'get', 'registry'], options);
  return res.ok ? res.stdout.replace(/\/+$/, '') : '';
}

function write(registryUrl, options = {}) {
  const parsed = parseHttpUrl(registryUrl);
  if (!parsed) return { ok: false, error: 'invalid_url' };
  const norm = parsed.toString();
  const res = execCommand('npm', ['config', 'set', 'registry', norm], options);
  return {
    ok: res.ok,
    registry: res.ok ? read(options) : '',
    error: res.ok ? null : (res.stderr || 'npm_config_failed'),
    exitCode: res.status
  };
}

module.exports = Object.freeze({
  id: 'npm',
  capability: 'toolkit.mirror',
  name: 'npm',
  label: 'npm / pnpm / yarn',
  settingLabel: 'npm registry',
  platforms: ALL,
  presets: PRESETS,
  guide: GUIDE,
  read,
  write
});
