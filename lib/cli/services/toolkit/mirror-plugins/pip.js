'use strict';

const { CLIENT_PLATFORMS } = require('../../../../runtime/client-platform');
const { execCommand, parseHttpUrl } = require('./mirror-command');

const ALL = Object.freeze([CLIENT_PLATFORMS.MACOS, CLIENT_PLATFORMS.WINDOWS, CLIENT_PLATFORMS.LINUX]);
const POSIX = Object.freeze([CLIENT_PLATFORMS.MACOS, CLIENT_PLATFORMS.LINUX]);
const WINDOWS = Object.freeze([CLIENT_PLATFORMS.WINDOWS]);

const PRESETS = Object.freeze([
  {
    id: 'tuna',
    name: '清华源 (TUNA)',
    url: 'https://pypi.tuna.tsinghua.edu.cn/simple',
    official: false,
    speed: '国内极速',
    desc: '清华大学开源软件镜像站，国内最常用的 PyPI 镜像之一'
  },
  {
    id: 'pypi',
    name: '官方源 (PyPI)',
    url: 'https://pypi.org/simple',
    official: true,
    speed: '全球官方',
    desc: 'Python 官方 PyPI 软件源，包版本最全最新'
  },
  {
    id: 'aliyun',
    name: '阿里云镜像',
    url: 'https://mirrors.aliyun.com/pypi/simple/',
    official: false,
    speed: '国内高速',
    desc: '阿里云公共 PyPI 镜像源，CDN 节点丰富'
  },
  {
    id: 'ustc',
    name: '中科大镜像',
    url: 'https://pypi.mirrors.ustc.edu.cn/simple/',
    official: false,
    speed: '国内高速',
    desc: '中国科学技术大学 PyPI 镜像源'
  },
  {
    id: 'douban',
    name: '豆瓣镜像',
    url: 'https://pypi.doubanio.com/simple/',
    official: false,
    speed: '国内高速',
    desc: '老牌经典豆瓣 PyPI 源，速度稳定'
  },
  {
    id: 'tencent',
    name: '腾讯云镜像',
    url: 'https://mirrors.cloud.tencent.com/pypi/simple/',
    official: false,
    speed: '国内高速',
    desc: '腾讯云公共 PyPI 镜像源'
  }
]);

const GUIDE = Object.freeze({
  title: 'Python pip 镜像配置命令行指南',
  commands: [
    {
      platform: 'All Platforms (CLI)',
      platforms: ALL,
      label: 'pip 一键设为全局源',
      cmd: 'pip config set global.index-url <URL>'
    },
    {
      platform: 'All Platforms (CLI)',
      platforms: ALL,
      label: 'pip 额外添加备用源 (extra-index-url)',
      cmd: 'pip config set global.extra-index-url <URL>'
    },
    {
      platform: 'All Platforms (CLI)',
      platforms: ALL,
      label: '单次临时安装使用镜像 (跳过信任警告)',
      cmd: 'pip install <package> -i <URL> --trusted-host <HOST>'
    },
    {
      platform: 'macOS / Linux (pip.conf)',
      platforms: POSIX,
      label: '写入 pip.conf',
      cmd: "mkdir -p ~/.pip && printf '[global]\\nindex-url = %s\\n' <URL> > ~/.pip/pip.conf"
    },
    {
      platform: 'Windows (PowerShell)',
      platforms: WINDOWS,
      label: 'Windows 写入 pip.ini',
      cmd: 'New-Item -ItemType Directory -Force -Path $env:APPDATA\\pip; Set-Content -Path $env:APPDATA\\pip\\pip.ini -Value ("[global]`nindex-url = " + <URL>)'
    }
  ]
});

function read(options = {}) {
  const res = execCommand('pip', ['config', 'get', 'global.index-url'], options);
  if (res.ok && res.stdout) return res.stdout;
  const res3 = execCommand('pip3', ['config', 'get', 'global.index-url'], options);
  return res3.ok ? res3.stdout : '';
}

// pip 不存在时回退 pip3；pip 存在但写入失败则直接报告，不掩盖真实错误。
function write(indexUrl, options = {}) {
  const parsed = parseHttpUrl(indexUrl);
  if (!parsed) return { ok: false, error: 'invalid_url' };
  const norm = parsed.toString();
  const res = execCommand('pip', ['config', 'set', 'global.index-url', norm], options);
  if (!res.ok) {
    const unavailable = res.status === null || res.status === 127 || /not found|not recognized|enoent/i.test(res.stderr);
    if (!unavailable) {
      return {
        ok: false,
        indexUrl: '',
        error: res.stderr || 'pip_config_failed',
        exitCode: res.status,
        attempts: [res]
      };
    }
    const res3 = execCommand('pip3', ['config', 'set', 'global.index-url', norm], options);
    return {
      ok: res3.ok,
      indexUrl: res3.ok ? read(options) : '',
      error: res3.ok ? null : (res3.stderr || res.stderr || 'pip_config_failed'),
      exitCode: res3.status,
      attempts: [res, res3]
    };
  }
  return { ok: true, indexUrl: read(options), error: null, exitCode: res.status };
}

module.exports = Object.freeze({
  id: 'pip',
  capability: 'toolkit.mirror',
  name: 'pip',
  label: 'Python pip',
  settingLabel: 'pip global.index-url',
  platforms: ALL,
  presets: PRESETS,
  guide: GUIDE,
  read,
  write
});
