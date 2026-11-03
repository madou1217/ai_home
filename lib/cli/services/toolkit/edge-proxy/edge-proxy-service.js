'use strict';

const nativeFs = require('node:fs');
const nativePath = require('node:path');
const { spawnSync: nativeSpawnSync } = require('node:child_process');

const frpProvider = require('./providers/frp');
const nginxProvider = require('./providers/nginx');
const caddyProvider = require('./providers/caddy');
const { replaceManagedBlock } = require('../../../../runtime/managed-text-block');

/** aih-edge 的受管块标记前缀（nginx 片段里的 `# >>> aih-edge:<domain> >>>`）。 */
const EDGE_BLOCK_PREFIX = 'aih-edge';

/**
 * 本机边缘转发管理（nginx / caddy / frp）：探测 → 生成配置 → 备份 → 写入 → **校验通过才重载**。
 *
 * 安全纪律（改坏一份反代配置的代价是把自己的入口关掉，尤其是 frp 那条 SSH 转发）：
 * 1. 写入前先备份（原地 `.bak-<时间戳>`），校验失败立刻整体回滚；
 * 2. 目标目录不可写就**明确报错**（`edge_config_not_writable`）并给出要执行的命令，不瞎猜 sudo；
 * 3. 只动带 AIH 标记的条目/文件，用户手写的配置原样保留；
 * 4. 校验/重载都通过注入的 `run` 执行，测试里可以替换成假执行器（不依赖本机装没装 nginx）。
 */

const DEFAULT_AIH_PORT = 9527;
const DEFAULT_TLS_TERMINATOR_PORT = 8443;

// 支持的转发软件**唯一声明处**：CLI、WebUI 路由、界面都从这里取，谁都不许再列一遍。
const EDGE_KINDS = Object.freeze(['frp', 'nginx', 'caddy']);

function listEdgeKinds() {
  return EDGE_KINDS;
}

function timestampSlug(now) {
  return new Date(now()).toISOString().replace(/[:.]/g, '-');
}

class EdgeProxyService {
  constructor(options = {}) {
    this.fs = options.fs || nativeFs;
    this.path = options.path || nativePath;
    this.env = options.env || process.env;
    this.now = options.now || (() => Date.now());
    this.run = options.run || ((command, args, runOptions = {}) => {
      const result = nativeSpawnSync(command, args, { encoding: 'utf8', timeout: 15000, ...runOptions });
      return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
    });
    this.aihPort = Number(options.aihPort || DEFAULT_AIH_PORT);
  }

  isWritable(target) {
    if (!target) return false;
    try {
      this.fs.accessSync(target, this.fs.constants?.W_OK || nativeFs.constants.W_OK);
      return true;
    } catch (_error) {
      return false;
    }
  }

  /** 本机有哪些边缘件、配置在哪、可不可写、AIH 相关条目是什么。 */
  status() {
    const frpBinary = frpProvider.resolveBinary({ fs: this.fs, env: this.env });
    const frpConfig = frpProvider.resolveConfigPath({ fs: this.fs, env: this.env });
    let proxies = [];
    if (frpConfig) {
      try {
        proxies = frpProvider.listProxies(this.fs.readFileSync(frpConfig, 'utf8'));
      } catch (_error) {
        proxies = [];
      }
    }
    const nginxBinary = nginxProvider.resolveBinary({ fs: this.fs, env: this.env });
    const nginxVersion = nginxBinary ? this.run(nginxBinary, ['-v']) : { stderr: '', stdout: '' };
    const caddyBinary = caddyProvider.resolveBinary({ fs: this.fs, env: this.env });
    return {
      ok: true,
      aihPort: this.aihPort,
      providers: {
        frp: {
          installed: Boolean(frpBinary),
          binary: frpBinary,
          configPath: frpConfig,
          writable: this.isWritable(frpConfig),
          proxies
        },
        nginx: {
          installed: Boolean(nginxBinary),
          binary: nginxBinary,
          configDir: nginxProvider.resolveConfigDir({
            fs: this.fs,
            env: this.env,
            versionOutput: `${nginxVersion.stderr || ''}${nginxVersion.stdout || ''}`
          }),
          version: /nginx\/([0-9.]+)/.exec(`${nginxVersion.stderr || ''}${nginxVersion.stdout || ''}`)?.[1] || ''
        },
        caddy: {
          installed: Boolean(caddyBinary),
          binary: caddyBinary,
          configPath: caddyProvider.resolveConfigPath({ fs: this.fs, env: this.env }),
          writable: this.isWritable(caddyProvider.resolveConfigPath({ fs: this.fs, env: this.env }))
        }
      }
    };
  }

  /**
   * 只生成、不落盘（给「复制粘贴」与 dry-run 用）。
   * → { kind, summary, files: [{ path, content, ... }], notes }
   */
  plan(kind, options = {}) {
    if (kind === 'frp') return this.planFrp(options);
    if (kind === 'nginx') return this.planNginx(options);
    if (kind === 'caddy') return this.planCaddy(options);
    throw Object.assign(new Error('edge_unknown_provider'), { code: 'edge_unknown_provider' });
  }

  planFrp({ name = 'aih-server', localPort = this.aihPort, remotePort, udp = true } = {}) {
    if (!remotePort) throw Object.assign(new Error('edge_remote_port_required'), { code: 'edge_remote_port_required' });
    const entries = [
      { name, type: 'tcp', localPort: Number(localPort), remotePort: Number(remotePort) },
      ...(udp ? [{ name: `${name}-udp`, type: 'udp', localPort: Number(localPort), remotePort: Number(remotePort) }] : [])
    ];
    return {
      kind: 'frp',
      name,
      entries,
      summary: `frp：本机 ${localPort}（TCP${udp ? ' + UDP' : ''}）→ 远端 ${remotePort}`,
      notes: [
        `客户端条目会是 socks5, <frp 服务端地址>, ${remotePort}, <用户名>, <密码>`,
        udp ? '含同号 UDP 条目：QUIC/HTTP3 走它' : '未含 UDP：QUIC 由客户端回落 TCP'
      ]
    };
  }

  planNginx({ domain, mode = 'split', aihPort = this.aihPort, certDir = '', tlsTerminatorPort = DEFAULT_TLS_TERMINATOR_PORT } = {}) {
    if (!domain) throw Object.assign(new Error('edge_domain_required'), { code: 'edge_domain_required' });
    // 形态判型只在 provider 里做一次（未知形态 = 直接拒绝，不降级成别的形态）。
    const resolvedMode = nginxProvider.normalizeMode(mode);
    const configDir = nginxProvider.resolveConfigDir({ fs: this.fs, env: this.env });
    const names = nginxProvider.fileNames(domain);
    const streamFile = this.path.join(configDir || '/etc/nginx', names.streamFile);
    const siteFile = this.path.join(configDir || '/etc/nginx', 'conf.d', names.siteFile);
    const files = [];
    if (resolvedMode === 'passthrough') {
      files.push({ path: streamFile, content: nginxProvider.passthroughStreamConfig({ aihPort }), topLevel: true });
    } else if (resolvedMode === 'split') {
      files.push({ path: streamFile, content: nginxProvider.streamConfig({ aihPort, tlsTerminatorPort }), topLevel: true });
      files.push({ path: siteFile, content: nginxProvider.siteConfig({ domain, aihPort, tlsTerminatorPort, certDir }) });
    } else {
      files.push({ path: siteFile, content: nginxProvider.httpOnlySiteConfig({ domain, aihPort, certDir }) });
    }
    return {
      kind: 'nginx',
      domain,
      mode: resolvedMode,
      files,
      summary: resolvedMode === 'split'
        ? `nginx：443/TCP 分流（TLS→WebUI，SOCKS5→AIH）+ 443/UDP 透传 —— 客户端 socks5, ${domain}, 443`
        : mode === 'passthrough'
          ? `nginx：443/TCP+UDP 纯透传 —— 客户端 socks5, ${domain}, 443（WebUI 只能 http）`
          : 'nginx：仅 https 反代 WebUI（SOCKS5 不在这个端口）',
      notes: resolvedMode === 'split'
        ? ['需要 nginx ≥ 1.25（ssl_preread_protocol）', `证书目录：${certDir || `/etc/letsencrypt/live/${domain}`}`]
        : resolvedMode === 'passthrough'
          ? ['纯四层透传：WebUI 只能 http；SOCKS5 与 UDP 都能用']
          : ['只有应用层：SOCKS5 上不来，中转走 frp 或 dedicated 模式']
    };
  }

  planCaddy({ domain, aihPort = this.aihPort } = {}) {
    if (!domain) throw Object.assign(new Error('edge_domain_required'), { code: 'edge_domain_required' });
    const configPath = caddyProvider.resolveConfigPath({ fs: this.fs, env: this.env });
    if (!configPath) throw Object.assign(new Error('edge_config_not_found'), { code: 'edge_config_not_found' });
    return {
      kind: 'caddy',
      domain,
      files: [{ path: configPath, content: caddyProvider.siteConfig({ domain, aihPort }), append: true }],
      summary: `Caddy：https://${domain} → AIH（证书自动申请）`,
      notes: ['标准 Caddy 不做四层转发；SOCKS5 中转请用 nginx 的 split 形态或 frp']
    };
  }

  /**
   * 落地一次变更：**备份 → 写入 → 校验 → 重载**，校验失败整体回滚。
   * 支持 kind：frp（改 frpc.toml 的 [[proxies]]）/ nginx / caddy（写片段 + 校验 + reload）。
   */
  apply(kind, options = {}) {
    const plan = this.plan(kind, options);
    if (options.dryRun === true) return { ok: true, dryRun: true, plan };

    if (kind === 'frp') return this.applyFrp(plan, options);
    if (kind === 'nginx') return this.applyNginx(plan, options);
    if (kind === 'caddy') return this.applyCaddy(plan, options);
    throw Object.assign(new Error('edge_unknown_provider'), { code: 'edge_unknown_provider' });
  }

  applyFrp(plan, options = {}) {
    if (!frpProvider.resolveBinary({ fs: this.fs, env: this.env })) {
      return { ok: false, error: 'edge_provider_not_installed', provider: 'frp' };
    }
    const configPath = frpProvider.resolveConfigPath({ fs: this.fs, env: this.env });
    if (!configPath) return { ok: false, error: 'edge_config_not_found', provider: 'frp' };
    if (!this.isWritable(configPath)) return { ok: false, error: 'edge_config_not_writable', configPath };
    const original = this.fs.readFileSync(configPath, 'utf8');
    let next = original;
    for (const entry of plan.entries) next = frpProvider.upsertProxy(next, entry);
    // 先落到临时文件校验：**校验通过才碰真配置**，所以永远不会留下连 frpc 都读不了的配置。
    const staged = `${configPath}.aih-staged`;
    this.writeAtomic(staged, next);
    const verified = this.run(frpProvider.resolveBinary({ fs: this.fs, env: this.env }), ['verify', '-c', staged]);
    if (verified.status !== 0) {
      this.removeFile(staged);
      return {
        ok: false,
        error: 'edge_config_rejected',
        detail: String(verified.stderr || verified.stdout || '').trim().slice(0, 400)
      };
    }
    const backupPath = this.writeAtomic(configPath, next, { backup: true });
    this.removeFile(staged);
    const reloaded = options.reload === false ? { reloaded: false, hint: '' } : this.reloadFrp();
    return {
      ok: true,
      provider: 'frp',
      configPath,
      summary: plan.summary,
      backupPath,
      entries: plan.entries,
      ...reloaded
    };
  }
  /** 重载 frpc：brew services / systemd(user) 各按本机实际装了哪种来，都没有就只提示。 */
  reloadFrp() {
    const plist = this.path.join(this.env.HOME || '', 'Library/LaunchAgents/homebrew.mxcl.frpc.plist');
    if (this.fs.existsSync(plist)) {
      const result = this.run('brew', ['services', 'restart', 'frpc']);
      return { reloaded: result.status === 0, reloadedVia: 'brew-services', detail: result.status === 0 ? '' : String(result.stderr || '').slice(0, 200) };
    }
    const userUnit = this.path.join(this.env.HOME || '', '.config/systemd/user/frpc.service');
    if (this.fs.existsSync(userUnit)) {
      const result = this.run('systemctl', ['--user', 'restart', 'frpc']);
      return { reloaded: result.status === 0, reloadedVia: 'systemd-user', detail: result.status === 0 ? '' : String(result.stderr || '').slice(0, 200) };
    }
    return { reloaded: false, reloadedVia: '', hint: 'frpc 不由本机服务管理器管：请手动重启它' };
  }

  /** 写文件（可选先备份）：返回备份路径（没备份则空串）。 */
  writeAtomic(target, content, options = {}) {
    let backupPath = '';
    if (options.backup && this.fs.existsSync(target)) {
      backupPath = `${target}.bak-${timestampSlug(this.now)}`;
      this.fs.writeFileSync(backupPath, this.fs.readFileSync(target, 'utf8'));
    }
    const temp = `${target}.aih-tmp-${process.pid}`;
    this.fs.writeFileSync(temp, content);
    this.fs.renameSync(temp, target);
    return backupPath;
  }

  removeFile(target) {
    try { this.fs.rmSync(target, { force: true }); } catch (_error) { /* 尽力而为 */ }
  }

  /** 回滚：有备份就还原，没有备份（原本不存在的文件）就删掉。 */
  rollback(written) {
    for (const file of written) {
      try {
        if (file.existed && file.backupPath) this.fs.copyFileSync(file.backupPath, file.path);
        else this.fs.rmSync(file.path, { force: true });
      } catch (_error) { /* 尽力而为 */ }
    }
  }

  /**
   * stream 块必须在 nginx.conf 的**顶层**（不在 http{} 里），而各发行版的 nginx.conf 通常只 include
   * conf.d/ 与 sites-enabled/，不会自动吃到我们写的文件 —— 所以这里幂等地补一行 include：
   * 插在第一个 `http {` 之前（保证是顶层），已有就不动。返回被改写的文件（供回滚）。
   */
  ensureTopLevelInclude(file) {
    const mainConf = this.path.join(this.path.dirname(file.path), 'nginx.conf');
    if (!this.fs.existsSync(mainConf)) return null;
    const text = this.fs.readFileSync(mainConf, 'utf8');
    if (text.includes(file.path)) return null;
    const lines = text.split('\n');
    const httpIndex = lines.findIndex((line) => /^\s*http\s*\{/.test(line));
    const includeLine = `include ${file.path};  # aih-edge:${this.path.basename(file.path)}`;
    if (httpIndex >= 0) lines.splice(httpIndex, 0, includeLine);
    else lines.push(includeLine);
    const backupPath = this.writeAtomic(mainConf, `${lines.join('\n')}`, { backup: true });
    return { path: mainConf, backupPath, existed: true };
  }

  /** nginx：写片段（顶层文件先补 include）→ `nginx -t` → reload；校验失败回滚到备份。 */
  applyNginx(plan, options = {}) {
    const binary = nginxProvider.resolveBinary({ fs: this.fs, env: this.env });
    if (!binary) return { ok: false, error: 'edge_provider_not_installed', provider: 'nginx' };
    const written = [];
    for (const file of plan.files) {
      if (!this.isWritable(this.path.dirname(file.path))) {
        this.rollback(written);
        return { ok: false, error: 'edge_config_not_writable', configPath: file.path };
      }
      const backupPath = this.writeAtomic(file.path, file.content, { backup: true });
      written.push({ path: file.path, backupPath, existed: Boolean(backupPath) });
      if (file.topLevel) {
        const include = this.ensureTopLevelInclude(file);
        if (include) written.push(include);
      }
    }
    const checked = this.run(binary, ['-t']);
    if (checked.status !== 0) {
      this.rollback(written);
      return { ok: false, error: 'edge_config_rejected', detail: String(checked.stderr || checked.stdout || '').trim().slice(0, 400) };
    }
    const reloaded = options.reload === false
      ? { reloaded: false }
      : { reloaded: this.run(binary, ['-s', 'reload']).status === 0, reloadedVia: 'nginx-s' };
    return { ok: true, provider: 'nginx', summary: plan.summary, files: written, ...reloaded };
  }

  /** Caddy：用 marker 块替换片段（重复 apply 不叠加）→ validate → reload。 */
  applyCaddy(plan, options = {}) {
    const binary = caddyProvider.resolveBinary({ fs: this.fs, env: this.env });
    if (!binary) return { ok: false, error: 'edge_provider_not_installed', provider: 'caddy' };
    const target = plan.files[0].path;
    // 文件还不存在时看**目录**可不可写（首次生成 Caddyfile 是正常用法）。
    const exists = this.fs.existsSync(target);
    const writable = exists ? this.isWritable(target) : this.isWritable(this.path.dirname(target));
    if (!writable) return { ok: false, error: 'edge_config_not_writable', configPath: target };
    const original = exists ? this.fs.readFileSync(target, 'utf8') : '';
    const next = this.replaceManagedBlock(original, plan.domain, plan.files[0].content);
    const backupPath = this.writeAtomic(target, next, { backup: true });
    const checked = this.run(binary, ['validate', '--config', target, '--adapter', 'caddyfile']);
    if (checked.status !== 0) {
      this.writeAtomic(target, original);
      return { ok: false, error: 'edge_config_rejected', detail: String(checked.stderr || checked.stdout || '').trim().slice(0, 400) };
    }
    const reloaded = options.reload === false
      ? { reloaded: false }
      : { reloaded: this.run(binary, ['reload', '--config', target, '--adapter', 'caddyfile']).status === 0, reloadedVia: 'caddy-reload' };
    return { ok: true, provider: 'caddy', configPath: target, backupPath, summary: plan.summary, ...reloaded };
  }

  /** 用 marker 块替换同名片段（重复 apply 不会叠加）。 */
  replaceManagedBlock(text, name, content) {
    // 语义（含标记形状）由 lib/runtime/managed-text-block.js 提供：
    // `aih shell` 写 rc 片段用的是同一份实现，两处不能再各写一遍。
    return replaceManagedBlock(text, name, content, { prefix: EDGE_BLOCK_PREFIX });
  }
}

module.exports = {
  DEFAULT_AIH_PORT,
  DEFAULT_TLS_TERMINATOR_PORT,
  EdgeProxyService,
  listEdgeKinds,
  timestampSlug
};

