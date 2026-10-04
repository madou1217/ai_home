'use strict';

const nativeFs = require('node:fs');
const nativePath = require('node:path');
const {
  DEFAULT_CONTROLLER_PORT,
  DEFAULT_MIXED_PORT,
  compileMihomoConfig
} = require('./config-compiler');
const {
  chooseLoopbackPort,
  knownMihomoCandidates,
  managedMihomoRoot,
  parseVersion
} = require('./core-manager');
const { atomicWritePrivateFile } = require('../../secure-file-io');
const {
  ProcessCoreRuntime,
  defaultListenerProbe,
  responseBodyText
} = require('../process-core-runtime');

function isExecutableFile(filePath, fsImpl = nativeFs) {
  if (!filePath) return false;
  try {
    const stat = fsImpl.statSync(filePath);
    if (!stat.isFile()) return false;
    if (typeof fsImpl.accessSync === 'function') {
      fsImpl.accessSync(filePath, fsImpl.constants?.X_OK || nativeFs.constants.X_OK);
    }
    return true;
  } catch (_error) {
    return false;
  }
}

function defaultResolveCommandPath(command, options = {}) {
  const env = options.env || process.env;
  const fsImpl = options.fs || nativeFs;
  const pathImpl = options.path || nativePath;
  const platform = options.platform || process.platform;
  const pathValue = String(env.PATH || '');
  const extensions = platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const directory of pathValue.split(pathImpl.delimiter || nativePath.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = pathImpl.join(directory, `${command}${extension}`);
      if (isExecutableFile(candidate, fsImpl)) return candidate;
    }
  }
  return '';
}

function discoverMihomoBinary(options = {}) {
  const env = options.env || process.env;
  const fsImpl = options.fs || nativeFs;
  const pathImpl = options.path || nativePath;
  const platform = options.platform || process.platform;
  const resolveCommandPath = options.resolveCommandPath || ((command) => (
    defaultResolveCommandPath(command, { env, fs: fsImpl, path: pathImpl, platform: options.platform })
  ));

  if (env.AIH_MIHOMO_BIN) {
    const explicitPath = pathImpl.resolve(String(env.AIH_MIHOMO_BIN));
    if (isExecutableFile(explicitPath, fsImpl)) {
      return { path: explicitPath, binaryName: pathImpl.basename(explicitPath) };
    }
    return null;
  }

  for (const binaryName of ['mihomo', 'clash-meta']) {
    try {
      const resolved = resolveCommandPath(binaryName);
      if (resolved) return { path: resolved, binaryName };
    } catch (_error) {
      // A resolver is an optional integration boundary. Failure means unavailable.
    }
  }
  const managedCandidates = [
    pathImpl.join(managedMihomoRoot({ aiHomeDir: options.aiHomeDir || env.AIH_HOME, env, path: pathImpl }), 'current', platform === 'win32' ? 'mihomo.exe' : 'mihomo'),
    pathImpl.join(managedMihomoRoot({ aiHomeDir: options.aiHomeDir || env.AIH_HOME, env, path: pathImpl }), 'current', 'mihomo')
  ];
  for (const candidate of [...managedCandidates, ...knownMihomoCandidates({ ...options, env, path: pathImpl })]) {
    if (!isExecutableFile(candidate, fsImpl)) continue;
    return { path: candidate, binaryName: pathImpl.basename(candidate), source: managedCandidates.includes(candidate) ? 'managed' : 'known-app', managed: managedCandidates.includes(candidate) };
  }
  return null;
}

const MIHOMO_RUNTIME_SPEC = Object.freeze({
  engine: 'mihomo',
  displayName: 'Mihomo',
  runtimeDirName: 'mihomo',
  configFileName: 'config.yaml',
  defaultControllerPort: DEFAULT_CONTROLLER_PORT,
  defaultMixedPort: DEFAULT_MIXED_PORT,
  discoverBinary: discoverMihomoBinary,
  versionArgs: ['-v'],
  parseVersion,
  chooseLoopbackPort,
  compileConfig: compileMihomoConfig,
  mixedPortOf: (compiled) => compiled?.config?.['mixed-port'],
  validateArgs: (runtime) => ['-t', '-d', runtime.runtimeDir, '-f', runtime.configPath],
  runArgs: (runtime) => ['-d', runtime.runtimeDir, '-f', runtime.configPath]
});

/**
 * Mihomo 内核运行时：共用骨架见 ../process-core-runtime.js；
 * Mihomo 支持经控制器 PUT /configs 热重载，覆写 _reload 并在失败时回滚到旧配置。
 */
class MihomoRuntime extends ProcessCoreRuntime {
  constructor(options = {}) {
    super(options, MIHOMO_RUNTIME_SPEC);
  }

  async _reload(state = {}) {
    if (!this.binary) {
      this.lastError = 'proxy_core_unavailable';
      return this._result('reload', false, { error: 'proxy_core_unavailable' });
    }
    if (!this._isRunning()) {
      this.lastError = 'proxy_core_not_running';
      return this._result('reload', false, { error: 'proxy_core_not_running' });
    }

    let compiled;
    let previousConfig = null;
    let reloadMayHaveReachedCore = false;
    try {
      try { previousConfig = this.fs.readFileSync(this.configPath, 'utf8'); } catch (_error) { /* first reload */ }
      compiled = await this._compileAndWrite(state);
      this._validateConfig();
      reloadMayHaveReachedCore = true;
      const response = await this.requestImpl(
        `http://127.0.0.1:${this.controllerPort}/configs?force=true`,
        {
          method: 'PUT',
          headers: this._controllerHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ path: this.configPath }),
          headersTimeout: 3000,
          bodyTimeout: 3000
        }
      );
      const responseText = await responseBodyText(response);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(responseText || `Mihomo reload returned HTTP ${response.statusCode}`);
      }
      this.ready = await this._probeReadiness() && await this._probeConfiguredListeners(compiled);
      if (!this.ready) {
        const error = new Error('proxy_core_readiness_failed');
        error.code = 'proxy_core_readiness_failed';
        throw error;
      }
      this.lastCompiled = compiled;
      this.lastError = null;
      return this._result('reload', true, { warnings: compiled.warnings });
    } catch (error) {
      if (previousConfig !== null) {
        try {
          this._restoreConfig(previousConfig);
          if (reloadMayHaveReachedCore && this._isRunning()) {
            const rollbackResponse = await this.requestImpl(
              `http://127.0.0.1:${this.controllerPort}/configs?force=true`,
              {
                method: 'PUT',
                headers: this._controllerHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ path: this.configPath }),
                headersTimeout: 3000,
                bodyTimeout: 3000
              }
            );
            await responseBodyText(rollbackResponse);
            this.ready = rollbackResponse.statusCode >= 200 && rollbackResponse.statusCode < 300
              ? await this._probeReadiness() && await this._probeConfiguredListeners(this.lastCompiled)
              : false;
          }
        } catch (_rollbackError) {
          this.ready = false;
        }
      }
      this.lastError = error.code || error.message;
      return this._result('reload', false, {
        error: error.code || 'proxy_core_reload_failed',
        message: error.message,
        warnings: compiled?.warnings || []
      });
    }
  }

}

module.exports = {
  MihomoRuntime,
  atomicWritePrivateFile,
  defaultResolveCommandPath,
  defaultListenerProbe,
  discoverMihomoBinary
};
