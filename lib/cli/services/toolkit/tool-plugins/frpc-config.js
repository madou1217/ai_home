'use strict';

const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const crypto = require('node:crypto');
const { spawnSync: nodeSpawnSync } = require('node:child_process');
const { resolveHostHomeDir } = require('../../../../runtime/host-home');

const FRPC_CONFIG_TEMPLATE = `# frpc 配置（由 AIH 创建）。文档：https://gofrp.org/zh-cn/docs/
serverAddr = "frps.example.com"
serverPort = 7000

# auth.method = "token"
# auth.token = "请替换为 frps 的 token"

# 登录失败时持续重试而不是直接退出，配合 AIH 自动重启
loginFailExit = false

[[proxies]]
name = "ssh"
type = "tcp"
localIP = "127.0.0.1"
localPort = 22
remotePort = 6000
`;

// 与 network-tool-discovery 的标准候选目录一致，新建后无需额外登记即可被探测与编辑。
function defaultFrpcConfigPath(options = {}) {
  const processObj = options.processObj || process;
  let home = String(options.hostHomeDir || '').trim();
  if (!home) {
    try {
      home = resolveHostHomeDir({ env: options.env || processObj.env, platform: processObj.platform, os: options.os || nodeOs });
    } catch (_error) {
      home = nodeOs.homedir();
    }
  }
  return nodePath.join(home, '.config', 'frp', 'frpc.toml');
}

/**
 * 保存前用 `frpc verify` 校验配置：写入同扩展名临时文件，校验失败不落盘。
 * 未安装 frpc 时跳过（返回 skipped），由格式层面的校验兜底。
 */
function verifyFrpcConfig(content, context = {}) {
  const executablePath = String(context.executablePath || '').trim();
  if (!executablePath) return { ok: true, skipped: true };
  const fs = context.fs || nodeFs;
  const spawnSync = context.spawnSync || nodeSpawnSync;
  const extension = nodePath.extname(String(context.targetPath || '')) || '.toml';
  const tmpDir = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'aih-frpc-verify-'));
  const tmpFile = nodePath.join(tmpDir, `frpc-${crypto.randomBytes(4).toString('hex')}${extension}`);
  try {
    fs.writeFileSync(tmpFile, String(content || ''), { encoding: 'utf8', mode: 0o600 });
    const result = spawnSync(executablePath, ['verify', '-c', tmpFile], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true
    });
    if (result && result.status === 0) return { ok: true };
    const output = `${result && result.stdout || ''}\n${result && result.stderr || ''}\n${result && result.error ? result.error.message : ''}`
      .split(tmpFile).join(nodePath.basename(String(context.targetPath || 'frpc.toml')))
      .trim();
    return { ok: false, message: output.slice(0, 800) || 'frpc verify 未通过' };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_error) {}
  }
}

module.exports = {
  FRPC_CONFIG_TEMPLATE,
  defaultFrpcConfigPath,
  verifyFrpcConfig
};
