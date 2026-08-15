'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawnSync: nodeSpawnSync, spawn: nodeSpawn } = require('node:child_process');
const os = require('node:os');
const { resolveHostHomeDir } = require('../../../runtime/host-home');

/**
 * EnvManager: manages language environments like Node.js (nvm, fnm, volta) and Python (pyenv, conda, venv).
 * Single Responsibility: Read and query runtime versions, manager tools, installed versions, and command cheatsheets.
 */

function resolveHostHome(options = {}) {
  if (String(options.hostHomeDir || '').trim()) return String(options.hostHomeDir).trim();
  const processObj = options.processObj || process;
  const env = options.env || processObj.env || {};
  try {
    return resolveHostHomeDir({
      env,
      platform: processObj.platform || process.platform,
      os: options.os || os
    });
  } catch (_error) {
    return String(env.USERPROFILE || env.HOME || '').trim();
  }
}

function execCommand(cmd, args = [], options = {}) {
  const spawnSyncImpl = options.spawnSync || nodeSpawnSync;
  const timeoutMs = options.probeTimeoutMs || 3000;
  try {
    const res = spawnSyncImpl(cmd, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: options.env || (options.processObj || process).env
    });
    const stdout = String(res && res.stdout || '').trim();
    const stderr = String(res && res.stderr || '').trim();
    return {
      ok: res && res.status === 0,
      status: res && Number.isInteger(res.status) ? res.status : null,
      stdout,
      stderr,
      value: res && res.status === 0 ? (stdout || stderr) : ''
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      stdout: '',
      stderr: String(error && error.message || error),
      value: ''
    };
  }
}

/**
 * Node.js command cheatsheet and guides for version switching, package managers installation
 */
const NODE_CHEATSHEET = {
  versionManagers: [
    {
      id: 'nvm',
      name: 'NVM (Node Version Manager)',
      platforms: ['macos', 'linux'],
      installGuide: 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash',
      commands: [
        { desc: '安装指定版本', cmd: 'nvm install 22' },
        { desc: '切换使用版本', cmd: 'nvm use 22' },
        { desc: '设置默认版本', cmd: 'nvm alias default 22' },
        { desc: '查看已安装版本', cmd: 'nvm ls' },
        { desc: '卸载指定版本', cmd: 'nvm uninstall 20' }
      ]
    },
    {
      id: 'fnm',
      name: 'FNM (Fast Node Manager - 极速 Rust 版)',
      platforms: ['macos', 'linux', 'windows'],
      installGuide: 'curl -fsSL https://fnm.vercel.app/install | bash (Windows: winget install Schniz.fnm)',
      commands: [
        { desc: '安装指定版本', cmd: 'fnm install 22' },
        { desc: '切换使用版本', cmd: 'fnm use 22' },
        { desc: '设置默认版本', cmd: 'fnm default 22' },
        { desc: '查看已安装版本', cmd: 'fnm list' },
        { desc: '卸载指定版本', cmd: 'fnm uninstall 20' }
      ]
    },
    {
      id: 'volta',
      name: 'Volta (零配置多版本管理器)',
      platforms: ['macos', 'linux', 'windows'],
      installGuide: 'curl https://get.volta.sh | bash (Windows: winget install Volta.Volta)',
      commands: [
        { desc: '安装并固定 Node 版本', cmd: 'volta install node@22' },
        { desc: '安装并固定 npm 版本', cmd: 'volta install npm@10' },
        { desc: '固定当前项目版本', cmd: 'volta pin node@22' },
        { desc: '查看已固定工具', cmd: 'volta list' }
      ]
    }
  ],
  packageManagers: [
    {
      id: 'pnpm',
      name: 'pnpm (极速、节省磁盘空间的包管理器)',
      statusCmd: 'pnpm -v',
      installCommands: [
        { platform: 'universal', method: 'Corepack (推荐)', cmd: 'corepack enable && corepack prepare pnpm@latest --activate' },
        { platform: 'universal', method: 'npm 全局安装', cmd: 'npm install -g pnpm' },
        { platform: 'macos', method: 'Homebrew', cmd: 'brew install pnpm' },
        { platform: 'windows', method: 'PowerShell', cmd: 'iwr https://get.pnpm.io/install.ps1 -useb | iex' }
      ],
      uninstallCommands: [
        { method: 'npm 卸载', cmd: 'npm uninstall -g pnpm' }
      ],
      commonCommands: [
        { desc: '安装依赖', cmd: 'pnpm install' },
        { desc: '添加包', cmd: 'pnpm add <package>' },
        { desc: '添加全局包', cmd: 'pnpm add -g <package>' },
        { desc: '运行脚本', cmd: 'pnpm run <script>' }
      ]
    },
    {
      id: 'yarn',
      name: 'Yarn (可靠快速的包管理器)',
      statusCmd: 'yarn -v',
      installCommands: [
        { platform: 'universal', method: 'Corepack (推荐)', cmd: 'corepack enable && corepack prepare yarn@stable --activate' },
        { platform: 'universal', method: 'npm 全局安装', cmd: 'npm install -g yarn' },
        { platform: 'macos', method: 'Homebrew', cmd: 'brew install yarn' }
      ],
      uninstallCommands: [
        { method: 'npm 卸载', cmd: 'npm uninstall -g yarn' }
      ],
      commonCommands: [
        { desc: '安装依赖', cmd: 'yarn install' },
        { desc: '添加包', cmd: 'yarn add <package>' },
        { desc: '运行脚本', cmd: 'yarn <script>' }
      ]
    },
    {
      id: 'bun',
      name: 'Bun (全合一高性能 JavaScript 运行时与包管理器)',
      statusCmd: 'bun -v',
      installCommands: [
        { platform: 'macos/linux', method: '官方一键脚本', cmd: 'curl -fsSL https://bun.sh/install | bash' },
        { platform: 'windows', method: 'PowerShell', cmd: 'powershell -c "irm bun.sh/install.ps1 | iex"' },
        { platform: 'macos', method: 'Homebrew', cmd: 'brew install oven-sh/bun/bun' }
      ],
      uninstallCommands: [
        { method: '清理目录', cmd: 'rm -rf ~/.bun' }
      ],
      commonCommands: [
        { desc: '安装依赖', cmd: 'bun install' },
        { desc: '添加包', cmd: 'bun add <package>' },
        { desc: '极速运行 JS/TS 文件', cmd: 'bun run index.ts' }
      ]
    }
  ]
};

/**
 * Python command cheatsheet and guides for virtual environments & version management
 */
const PYTHON_CHEATSHEET = {
  versionManagers: [
    {
      id: 'pyenv',
      name: 'Pyenv (Python 多版本管理器)',
      installGuide: 'macOS: brew install pyenv | Linux: curl https://pyenv.run | bash',
      commands: [
        { desc: '安装指定版本', cmd: 'pyenv install 3.12.7' },
        { desc: '设置全局版本', cmd: 'pyenv global 3.12.7' },
        { desc: '设置当前目录版本', cmd: 'pyenv local 3.12.7' },
        { desc: '查看可用版本', cmd: 'pyenv install --list' },
        { desc: '查看已安装版本', cmd: 'pyenv versions' },
        { desc: '卸载指定版本', cmd: 'pyenv uninstall 3.11.0' }
      ]
    },
    {
      id: 'conda',
      name: 'Conda / Miniconda (科学计算与环境管理)',
      installGuide: '下载 Miniconda 官方安装包或通过 Homebrew: brew install --cask miniconda',
      commands: [
        { desc: '创建新环境', cmd: 'conda create -n myenv python=3.11' },
        { desc: '激活环境', cmd: 'conda activate myenv' },
        { desc: '退出环境', cmd: 'conda deactivate' },
        { desc: '列出所有环境', cmd: 'conda env list' },
        { desc: '删除环境', cmd: 'conda env remove -n myenv' }
      ]
    }
  ],
  virtualEnvironments: [
    {
      id: 'venv',
      name: 'Python 标准库 venv',
      recommended: true,
      commands: [
        { platform: 'macOS/Linux', desc: '创建虚拟环境', cmd: 'python3 -m venv .venv' },
        { platform: 'macOS/Linux', desc: '激活虚拟环境', cmd: 'source .venv/bin/activate' },
        { platform: 'Windows (PowerShell)', desc: '创建虚拟环境', cmd: 'python -m venv .venv' },
        { platform: 'Windows (PowerShell)', desc: '激活虚拟环境', cmd: '.\\.venv\\Scripts\\Activate.ps1' },
        { platform: 'Windows (CMD)', desc: '激活虚拟环境', cmd: '.\\.venv\\Scripts\\activate.bat' },
        { platform: 'universal', desc: '退出虚拟环境', cmd: 'deactivate' }
      ]
    },
    {
      id: 'uv',
      name: 'uv (极速 Rust 版 Python 包与虚拟环境管理器)',
      recommended: true,
      installGuide: 'curl -LsSf https://astral.sh/uv/install.sh | sh (Windows: powershell -c "irm https://astral.sh/uv/install.ps1 | iex")',
      commands: [
        { desc: '创建虚拟环境', cmd: 'uv venv' },
        { desc: '极速安装依赖包', cmd: 'uv pip install <package>' },
        { desc: '根据 requirements.txt 安装', cmd: 'uv pip install -r requirements.txt' },
        { desc: '在隔离环境中运行脚本', cmd: 'uv run script.py' }
      ]
    },
    {
      id: 'poetry',
      name: 'Poetry (现代 Python 依赖与打包管理)',
      installGuide: 'curl -sSL https://install.python-poetry.org | python3 -',
      commands: [
        { desc: '初始化项目', cmd: 'poetry init' },
        { desc: '安装依赖环境', cmd: 'poetry install' },
        { desc: '添加包', cmd: 'poetry add <package>' },
        { desc: '激活虚拟环境 Shell', cmd: 'poetry shell' },
        { desc: '在环境中执行命令', cmd: 'poetry run python main.py' }
      ]
    }
  ]
};

/**
 * Detect Node.js environment: current version, path, package managers, and nvm/fnm/volta installed versions.
 */
function detectNodeEnvironment(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const processObj = options.processObj || process;
  const hostHome = resolveHostHome(options);

  const nodeVersionProbe = execCommand('node', ['--version'], options);
  const pathCommand = processObj.platform === 'win32' ? 'where' : 'which';
  const nodePathProbe = execCommand(pathCommand, ['node'], options);
  const nodeVersion = nodeVersionProbe.value;
  const nodePathVal = nodePathProbe.value.split(/\r?\n/)[0] || '';

  // Package managers
  const npmVersion = execCommand('npm', ['-v'], options).value;
  const pnpmVersion = execCommand('pnpm', ['-v'], options).value;
  const yarnVersion = execCommand('yarn', ['-v'], options).value;
  const bunVersion = execCommand('bun', ['-v'], options).value;

  // Version managers detection
  const managers = [];

  // 1. nvm: check ~/.nvm/versions/node
  const nvmVersionsDir = pathImpl.join(hostHome, '.nvm', 'versions', 'node');
  const nvmVersions = [];
  if (fsImpl.existsSync(nvmVersionsDir)) {
    try {
      const entries = fsImpl.readdirSync(nvmVersionsDir);
      for (const entry of entries) {
        if (entry.startsWith('v')) {
          nvmVersions.push(entry);
        }
      }
    } catch (_e) {}
    managers.push({
      name: 'nvm',
      displayName: 'NVM (Node Version Manager)',
      installed: true,
      path: pathImpl.join(hostHome, '.nvm'),
      versions: nvmVersions.sort().reverse()
    });
  }

  // 2. fnm: check ~/.fnm or fnm command
  const fnmCmd = execCommand('fnm', ['--version'], options).value;
  const fnmVersions = [];
  const fnmDir = pathImpl.join(hostHome, '.local', 'share', 'fnm');
  const fnmAltDir = pathImpl.join(hostHome, '.fnm');
  const targetFnmDir = fsImpl.existsSync(fnmDir) ? fnmDir : (fsImpl.existsSync(fnmAltDir) ? fnmAltDir : null);

  if (targetFnmDir) {
    try {
      const currentDir = pathImpl.join(targetFnmDir, 'current');
      if (fsImpl.existsSync(currentDir)) {
        const entries = fsImpl.readdirSync(targetFnmDir);
        for (const entry of entries) {
          if (entry.startsWith('v') || entry.startsWith('node-v')) fnmVersions.push(entry);
        }
      }
    } catch (_e) {}
  }

  if (fnmCmd || targetFnmDir) {
    managers.push({
      name: 'fnm',
      displayName: 'FNM (Fast Node Manager)',
      installed: true,
      version: fnmCmd,
      path: targetFnmDir || '系统 PATH',
      versions: fnmVersions
    });
  }

  // 3. volta: check ~/.volta or volta command
  const voltaCmd = execCommand('volta', ['-v'], options).value;
  if (voltaCmd || fsImpl.existsSync(pathImpl.join(hostHome, '.volta'))) {
    managers.push({
      name: 'volta',
      displayName: 'Volta',
      installed: true,
      version: voltaCmd,
      path: pathImpl.join(hostHome, '.volta')
    });
  }

  return {
    name: 'Node.js',
    scope: 'aih-server-process-path',
    source: 'command-probe',
    probeStatus: nodeVersionProbe.ok ? 'available' : (nodeVersionProbe.status === null ? 'error' : 'unavailable'),
    currentVersion: nodeVersion || '',
    activePath: nodePathVal || '',
    packageManagers: {
      npm: npmVersion || null,
      pnpm: pnpmVersion || null,
      yarn: yarnVersion || null,
      bun: bunVersion || null
    },
    versionManagers: managers,
    installedVersions: nvmVersions.length ? nvmVersions : [nodeVersion].filter(Boolean),
    cheatsheet: NODE_CHEATSHEET
  };
}

/**
 * Detect Python environment: current version, path, pip, and pyenv/conda/venv
 */
function detectPythonEnvironment(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const processObj = options.processObj || process;
  const hostHome = resolveHostHome(options);

  const python3Probe = execCommand('python3', ['--version'], options);
  const pythonProbe = python3Probe.ok ? python3Probe : execCommand('python', ['--version'], options);
  const pathCommand = processObj.platform === 'win32' ? 'where' : 'which';
  const python3PathProbe = execCommand(pathCommand, ['python3'], options);
  const pythonPathProbe = python3PathProbe.ok ? python3PathProbe : execCommand(pathCommand, ['python'], options);
  const pip3Probe = execCommand('pip3', ['--version'], options);
  const pipProbe = pip3Probe.ok ? pip3Probe : execCommand('pip', ['--version'], options);
  const pythonVersion = pythonProbe.value;
  const pythonPathVal = pythonPathProbe.value.split(/\r?\n/)[0] || '';
  const pipVersion = pipProbe.value;
  const uvVersion = execCommand('uv', ['--version'], options).value;
  const poetryVersion = execCommand('poetry', ['--version'], options).value;

  const managers = [];

  // pyenv: check ~/.pyenv/versions
  const pyenvDir = pathImpl.join(hostHome, '.pyenv', 'versions');
  const pyenvVersions = [];
  if (fsImpl.existsSync(pyenvDir)) {
    try {
      const entries = fsImpl.readdirSync(pyenvDir);
      for (const entry of entries) {
        if (!entry.startsWith('.')) {
          pyenvVersions.push(entry);
        }
      }
    } catch (_e) {}
    managers.push({
      name: 'pyenv',
      displayName: 'Pyenv',
      installed: true,
      path: pathImpl.join(hostHome, '.pyenv'),
      versions: pyenvVersions
    });
  }

  // conda: check conda command or directories
  const condaVersion = execCommand('conda', ['--version'], options).value;
  const condaEnvs = [];
  const condaDirs = [
    pathImpl.join(hostHome, 'miniconda3', 'envs'),
    pathImpl.join(hostHome, 'anaconda3', 'envs'),
    pathImpl.join(hostHome, '.conda', 'envs')
  ];

  for (const cDir of condaDirs) {
    if (fsImpl.existsSync(cDir)) {
      try {
        const entries = fsImpl.readdirSync(cDir);
        for (const entry of entries) {
          if (!entry.startsWith('.')) condaEnvs.push(entry);
        }
      } catch (_e) {}
    }
  }

  if (condaVersion || condaEnvs.length > 0) {
    managers.push({
      name: 'conda',
      displayName: 'Conda',
      installed: true,
      version: condaVersion || '已安装',
      versions: condaEnvs
    });
  }

  return {
    name: 'Python',
    scope: 'aih-server-process-path',
    source: 'command-probe',
    probeStatus: pythonProbe.ok ? 'available' : (pythonProbe.status === null ? 'error' : 'unavailable'),
    currentVersion: pythonVersion || '',
    activePath: pythonPathVal || '',
    pip: pipVersion ? pipVersion.split(' ')[1] || pipVersion : null,
    tools: {
      uv: uvVersion || null,
      poetry: poetryVersion || null
    },
    versionManagers: managers,
    installedVersions: pyenvVersions.length ? pyenvVersions : [pythonVersion].filter(Boolean),
    cheatsheet: PYTHON_CHEATSHEET
  };
}

/**
 * Get all environment summaries
 */
function getEnvironmentsSummary(options = {}) {
  return {
    ok: true,
    environments: {
      node: detectNodeEnvironment(options),
      python: detectPythonEnvironment(options)
    }
  };
}

const VERSION_PATTERN = /^v?\d{1,3}(?:\.\d{1,3}){0,2}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FIXED_NVM_SCRIPT = [
  'set -eu',
  '. "$NVM_DIR/nvm.sh"',
  'case "$AIH_ENV_ACTION" in',
  '  install|uninstall) nvm "$AIH_ENV_ACTION" "$AIH_ENV_VERSION" ;;',
  '  default) nvm alias default "$AIH_ENV_VERSION" ;;',
  '  *) exit 64 ;;',
  'esac'
].join('\n');

function invalidPlan(error, message, extra = {}) {
  return { ok: false, error, message, ...extra };
}

function validateVersion(version) {
  const value = String(version || '').trim();
  return VERSION_PATTERN.test(value) ? value : '';
}

function validateEnvironmentName(name) {
  const value = String(name || '').trim();
  return ENVIRONMENT_NAME_PATTERN.test(value) ? value : '';
}

function resolveVenvTarget(rawPath, options = {}) {
  const pathImpl = options.path || nodePath;
  const processObj = options.processObj || process;
  const cwd = String(options.cwd || (typeof processObj.cwd === 'function' ? processObj.cwd() : '') || '').trim();
  const value = String(rawPath || '').trim();
  if (!cwd || !value || value.length > 512 || /[\0\r\n]/.test(value) || value.startsWith('~')) return '';

  const target = pathImpl.resolve(cwd, value);
  const relative = pathImpl.relative(cwd, target);
  if (!relative || relative === '.' || relative.startsWith(`..${pathImpl.sep}`) || relative === '..' || pathImpl.isAbsolute(relative)) {
    return '';
  }
  return target;
}

function createPlan(manager, action, command, args, extra = {}) {
  return {
    ok: true,
    plan: {
      manager,
      action,
      command,
      args,
      env: extra.env || {},
      cwd: extra.cwd || null,
      scope: extra.scope || 'new-child-process',
      effect: extra.effect || '',
      requiresConfirmation: true,
      changesCallerShell: false
    }
  };
}

/**
 * Build an auditable command from a closed manager/action allowlist.
 * It never accepts raw commands and never interpolates request data into shell source.
 */
function planEnvironmentAction(input = {}, options = {}) {
  const manager = String(input.manager || '').trim().toLowerCase();
  const action = String(input.action || '').trim().toLowerCase();
  const processObj = options.processObj || process;

  if (action === 'use' || action === 'activate' || action === 'deactivate') {
    return invalidPlan(
      'interactive_shell_action_unsupported',
      '切换或激活只会影响调用者当前 Shell，服务端子进程无法修改已打开的终端。',
      { scope: 'caller-shell' }
    );
  }

  const versionActions = new Set(['install', 'uninstall', 'default', 'global']);
  const version = versionActions.has(action) ? validateVersion(input.version) : '';
  if (versionActions.has(action) && !version) {
    return invalidPlan('invalid_version', '版本只能包含数字、点、可选 v 前缀和安全预发布后缀。');
  }

  if (manager === 'nvm') {
    if (!['install', 'uninstall', 'default'].includes(action)) {
      return invalidPlan('unsupported_environment_action', 'NVM 仅支持 install、uninstall、default。');
    }
    if (processObj.platform === 'win32') {
      return invalidPlan('unsupported_platform', '该 NVM 执行器仅支持 macOS 与 Linux。');
    }
    const nvmDir = (options.path || nodePath).join(resolveHostHome(options), '.nvm');
    return createPlan('nvm', action, '/bin/sh', ['-c', FIXED_NVM_SCRIPT], {
      env: {
        NVM_DIR: nvmDir,
        AIH_ENV_ACTION: action,
        AIH_ENV_VERSION: version
      },
      scope: 'nvm-managed-installation',
      effect: action === 'default'
        ? `设置 NVM 新 Shell 的默认 Node.js 版本为 ${version}`
        : `${action === 'install' ? '安装' : '卸载'} NVM Node.js ${version}`
    });
  }

  if (manager === 'fnm') {
    if (!['install', 'uninstall', 'default'].includes(action)) {
      return invalidPlan('unsupported_environment_action', 'FNM 仅支持 install、uninstall、default。');
    }
    return createPlan('fnm', action, 'fnm', [action, version], {
      effect: `${action === 'default' ? '设置默认' : action === 'install' ? '安装' : '卸载'} FNM Node.js ${version}`
    });
  }

  if (manager === 'pyenv') {
    if (!['install', 'uninstall', 'global'].includes(action)) {
      return invalidPlan('unsupported_environment_action', 'Pyenv 仅支持 install、uninstall、global。');
    }
    const args = action === 'uninstall' ? ['uninstall', '--force', version] : [action, version];
    return createPlan('pyenv', action, 'pyenv', args, {
      effect: `${action === 'global' ? '设置新 Shell 的全局' : action === 'install' ? '安装' : '卸载'} Python ${version}`
    });
  }

  if (manager === 'conda') {
    if (!['create', 'remove'].includes(action)) {
      return invalidPlan('unsupported_environment_action', 'Conda 仅支持 create、remove。');
    }
    const name = validateEnvironmentName(input.name);
    if (!name) return invalidPlan('invalid_environment_name', '环境名只能包含字母、数字、下划线和连字符。');
    if (action === 'create') {
      const pythonVersion = validateVersion(input.pythonVersion || input.version);
      if (!pythonVersion) return invalidPlan('invalid_version', '创建 Conda 环境必须提供安全的 Python 版本。');
      return createPlan('conda', action, 'conda', ['create', '--yes', '--name', name, `python=${pythonVersion}`], {
        effect: `创建 Conda 环境 ${name}（Python ${pythonVersion}）`
      });
    }
    return createPlan('conda', action, 'conda', ['env', 'remove', '--yes', '--name', name], {
      effect: `删除 Conda 环境 ${name}`
    });
  }

  if (manager === 'venv') {
    if (action !== 'create') return invalidPlan('unsupported_environment_action', 'venv 仅支持 create。');
    const target = resolveVenvTarget(input.path, options);
    if (!target) return invalidPlan('invalid_environment_path', 'venv 路径必须是当前工作目录内的安全子路径。');
    const cwd = String(options.cwd || (typeof processObj.cwd === 'function' ? processObj.cwd() : ''));
    return createPlan('venv', action, processObj.platform === 'win32' ? 'python' : 'python3', ['-m', 'venv', target], {
      cwd,
      effect: `在 ${target} 创建 Python venv`
    });
  }

  return invalidPlan('unsupported_environment_manager', '不支持的环境管理器。');
}

function runEnvironmentPlan(plan, options = {}) {
  const spawnImpl = options.spawn || nodeSpawn;
  const processObj = options.processObj || process;
  const timeoutMs = Math.min(Math.max(Number(options.actionTimeoutMs) || 120000, 1000), 10 * 60 * 1000);
  const maxOutputBytes = Math.min(Math.max(Number(options.maxOutputBytes) || 64 * 1024, 1024), 1024 * 1024);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(plan.command, plan.args, {
        cwd: plan.cwd || undefined,
        env: { ...(options.env || processObj.env || {}), ...plan.env },
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({ ok: false, error: 'environment_action_spawn_failed', message: String(error && error.message || error) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let capturedBytes = 0;
    let outputTruncated = false;
    let settled = false;
    const append = (current, chunk) => {
      const remaining = maxOutputBytes - capturedBytes;
      if (remaining <= 0) {
        outputTruncated = true;
        return current;
      }
      const chunkBuffer = Buffer.from(chunk);
      const captured = chunkBuffer.subarray(0, remaining);
      const value = captured.toString('utf8');
      capturedBytes += captured.length;
      if (chunkBuffer.length > remaining) outputTruncated = true;
      return current + value;
    };
    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        outputTruncated
      });
    };
    const timer = setTimeout(() => {
      if (child && typeof child.kill === 'function') child.kill('SIGTERM');
      finish({ ok: false, error: 'environment_action_timeout', timedOut: true });
    }, timeoutMs);

    child.on('error', (error) => {
      finish({ ok: false, error: 'environment_action_spawn_failed', message: String(error && error.message || error) });
    });
    child.on('close', (code, signal) => {
      finish({
        ok: code === 0,
        error: code === 0 ? null : 'environment_action_failed',
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal || null
      });
    });
  });
}

async function executeEnvironmentAction(input = {}, options = {}) {
  const planned = planEnvironmentAction(input, options);
  if (!planned.ok) return planned;
  if (input.confirmed !== true) {
    return {
      ok: false,
      error: 'confirmation_required',
      message: '执行环境变更前必须显式确认。',
      plan: planned.plan
    };
  }

  const result = await runEnvironmentPlan(planned.plan, options);
  return { ...result, plan: planned.plan };
}

module.exports = {
  detectNodeEnvironment,
  detectPythonEnvironment,
  getEnvironmentsSummary,
  planEnvironmentAction,
  executeEnvironmentAction,
  NODE_CHEATSHEET,
  PYTHON_CHEATSHEET
};
