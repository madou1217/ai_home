'use strict';

const {
  buildCommandPlan,
  buildNpmGlobalPlan,
  buildShellScriptPlan,
  createLifecyclePlan,
  shellQuote
} = require('../plan-builders');
const {
  buildCondaCleanupPlan,
  buildHomeCleanupPlan,
  buildPoetryInstallerPlan,
  buildProfileAwareCleanupPlan,
  buildSelfUpdatePlan,
  resolveHome
} = require('./shared');

const INSTALLERS = Object.freeze({
  nvm: Object.freeze({ url: 'https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh', hosts: ['raw.githubusercontent.com'] }),
  fnm: Object.freeze({ url: 'https://fnm.vercel.app/install', hosts: ['fnm.vercel.app'] }),
  volta: Object.freeze({ url: 'https://get.volta.sh', hosts: ['get.volta.sh'] }),
  bun: Object.freeze({ url: 'https://bun.sh/install', hosts: ['bun.sh'] }),
  pyenv: Object.freeze({ url: 'https://pyenv.run', hosts: ['pyenv.run'] }),
  uv: Object.freeze({ url: 'https://astral.sh/uv/install.sh', hosts: ['astral.sh'] })
});

function officialScript(toolId, action, name, options = {}) {
  return buildShellScriptPlan(toolId, action, {
    ...INSTALLERS[toolId],
    label: `${action === 'update' ? '更新' : '安装'} ${name}`,
    method: '官方安装器',
    options
  });
}

function buildMinicondaInstallPlan(action, options = {}) {
  const home = resolveHome(options);
  const script = [
    'set -euo pipefail',
    'arch="$(uname -m)"',
    'case "$arch" in x86_64|amd64) asset="Miniconda3-latest-Linux-x86_64.sh" ;; aarch64|arm64) asset="Miniconda3-latest-Linux-aarch64.sh" ;; *) echo "不支持的 Linux 架构: $arch" >&2; exit 64 ;; esac',
    'url="https://repo.anaconda.com/miniconda/$asset"',
    'tmp="$(mktemp --suffix=.sh aih-miniconda.XXXXXX)"',
    'trap \'rm -f "$tmp"\' EXIT',
    'curl --compressed -fsSL "$url" -o "$tmp"',
    `bash "$tmp" -b -u -p ${shellQuote(`${home}/miniconda3`)}`
  ].join('\n');
  return createLifecyclePlan('conda', action, 'bash', ['-c', script], {
    id: `conda_${action}_official_installer`,
    label: `${action === 'update' ? '更新' : '安装'} Miniconda`,
    method: 'Miniconda 官方安装器',
    effect: `${action === 'update' ? '覆盖更新' : '安装'} Miniconda 到用户目录`
  });
}

function buildCondaUpdatePlan(options = {}) {
  const home = resolveHome(options);
  const script = [
    'set -e',
    `conda_bin=${shellQuote(`${home}/miniconda3/bin/conda`)}`,
    'if [ ! -x "$conda_bin" ]; then conda_bin="$(command -v conda)"; fi',
    '"$conda_bin" update --name base --yes conda'
  ].join('\n');
  return createLifecyclePlan('conda', 'update', 'bash', ['-c', script], {
    id: 'conda_update_base',
    label: '更新 Miniconda',
    method: 'conda',
    effect: '更新 base 环境中的 conda'
  });
}

function resolveLinuxEnvironmentPlans(toolId, action, options = {}) {
  const name = options.name || toolId;
  if (toolId === 'nvm') {
    if (action === 'uninstall') {
      return [buildProfileAwareCleanupPlan('nvm', 'NVM', ['NVM_DIR', 'nvm\\.sh', 'bash_completion'], { trees: ['.nvm'] }, options)];
    }
    return [officialScript('nvm', action, 'NVM', options)];
  }

  if (toolId === 'fnm') {
    if (action === 'uninstall') {
      return [buildProfileAwareCleanupPlan('fnm', 'FNM', ['fnm env', 'FNM_DIR'], {
        files: ['.local/bin/fnm'],
        trees: ['.local/share/fnm', '.fnm']
      }, options)];
    }
    return [officialScript('fnm', action, 'FNM', options)];
  }

  if (toolId === 'volta') {
    if (action === 'uninstall') {
      return [buildProfileAwareCleanupPlan('volta', 'Volta', ['VOLTA_HOME', '\\.volta/bin'], { trees: ['.volta'] }, options)];
    }
    return [officialScript('volta', action, 'Volta', options)];
  }

  if (toolId === 'pnpm' || toolId === 'yarn') {
    return [buildNpmGlobalPlan(toolId, action, toolId, { ...options, platform: 'linux', name })];
  }

  if (toolId === 'bun') {
    if (action === 'update') return [buildSelfUpdatePlan('bun', 'Bun', 'bun', ['upgrade']), officialScript('bun', action, 'Bun', options)];
    if (action === 'uninstall') {
      return [buildProfileAwareCleanupPlan('bun', 'Bun', ['BUN_INSTALL', '\\.bun/bin'], { trees: ['.bun'] }, options)];
    }
    return [officialScript('bun', action, 'Bun', options)];
  }

  if (toolId === 'pyenv') {
    if (action === 'update') {
      return [
        buildCommandPlan('pyenv', 'update', 'git', ['-C', `${resolveHome(options)}/.pyenv`, 'pull', '--ff-only'], {
          id: 'pyenv_git_update',
          label: '更新 Pyenv',
          method: 'Git',
          effect: '更新用户目录中的 Pyenv'
        }),
        officialScript('pyenv', action, 'Pyenv', options)
      ];
    }
    if (action === 'uninstall') {
      return [buildProfileAwareCleanupPlan('pyenv', 'Pyenv', ['PYENV_ROOT', 'pyenv init'], { trees: ['.pyenv'] }, options)];
    }
    return [officialScript('pyenv', action, 'Pyenv', options)];
  }

  if (toolId === 'conda') {
    if (action === 'update') return [buildCondaUpdatePlan(options), buildMinicondaInstallPlan(action, options)];
    if (action === 'uninstall') return [buildCondaCleanupPlan(options)];
    return [buildMinicondaInstallPlan(action, options)];
  }

  if (toolId === 'uv') {
    if (action === 'update') return [buildSelfUpdatePlan('uv', 'uv', 'uv', ['self', 'update']), officialScript('uv', action, 'uv', options)];
    if (action === 'uninstall') {
      return [
        buildCommandPlan('uv', 'uninstall', 'uv', ['self', 'uninstall'], {
          id: 'uv_self_uninstall',
          label: 'uv 自卸载',
          method: '内置卸载器',
          effect: '卸载 uv'
        }),
        buildHomeCleanupPlan('uv', 'uv', options, { files: ['.local/bin/uv', '.local/bin/uvx'], trees: ['.local/share/uv'] })
      ];
    }
    return [officialScript('uv', action, 'uv', options)];
  }

  if (toolId === 'poetry') {
    if (action === 'update') return [buildSelfUpdatePlan('poetry', 'Poetry', 'poetry', ['self', 'update']), buildPoetryInstallerPlan('install', { ...options, platform: 'linux' })];
    if (action === 'uninstall') return [buildPoetryInstallerPlan('uninstall', { ...options, platform: 'linux' })];
    return [buildPoetryInstallerPlan('install', { ...options, platform: 'linux' })];
  }

  return [];
}

module.exports = {
  resolveLinuxEnvironmentPlans
};
