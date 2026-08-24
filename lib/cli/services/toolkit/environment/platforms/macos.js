'use strict';

const {
  buildBrewPlan,
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
  const installer = INSTALLERS[toolId];
  return buildShellScriptPlan(toolId, action, {
    ...installer,
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
    'case "$arch" in arm64) asset="Miniconda3-latest-MacOSX-arm64.sh" ;; x86_64) asset="Miniconda3-latest-MacOSX-x86_64.sh" ;; *) echo "不支持的 macOS 架构: $arch" >&2; exit 64 ;; esac',
    'url="https://repo.anaconda.com/miniconda/$asset"',
    'tmp="$(mktemp -t aih-miniconda.XXXXXX)"',
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

function resolveMacosEnvironmentPlans(toolId, action, options = {}) {
  const name = options.name || toolId;
  if (toolId === 'nvm') {
    if (action === 'uninstall') {
      return [buildProfileAwareCleanupPlan('nvm', 'NVM', [
        'NVM_DIR',
        'nvm\\.sh',
        'bash_completion'
      ], { trees: ['.nvm'] }, options)];
    }
    return [officialScript('nvm', action, 'NVM', options)];
  }

  if (toolId === 'fnm') {
    if (action === 'uninstall') {
      return [
        buildBrewPlan('fnm', action, 'fnm', { name: 'FNM' }),
        buildProfileAwareCleanupPlan('fnm', 'FNM', ['fnm env', 'FNM_DIR'], {
          files: ['.local/bin/fnm'],
          trees: ['.local/share/fnm', '.fnm']
        }, options)
      ];
    }
    return [buildBrewPlan('fnm', action, 'fnm', { name: 'FNM' }), officialScript('fnm', action, 'FNM', options)];
  }

  if (toolId === 'volta') {
    if (action === 'uninstall') {
      return [
        buildBrewPlan('volta', action, 'volta', { name: 'Volta' }),
        buildProfileAwareCleanupPlan('volta', 'Volta', ['VOLTA_HOME', '\\.volta/bin'], { trees: ['.volta'] }, options)
      ];
    }
    return [buildBrewPlan('volta', action, 'volta', { name: 'Volta' }), officialScript('volta', action, 'Volta', options)];
  }

  if (toolId === 'pnpm' || toolId === 'yarn') {
    const packageName = toolId;
    return [
      buildBrewPlan(toolId, action, packageName, { name }),
      buildNpmGlobalPlan(toolId, action, packageName, { ...options, platform: 'macos', name })
    ];
  }

  if (toolId === 'bun') {
    if (action === 'update') {
      return [buildSelfUpdatePlan('bun', 'Bun', 'bun', ['upgrade']), buildBrewPlan('bun', action, 'oven-sh/bun/bun', { name: 'Bun' }), officialScript('bun', action, 'Bun', options)];
    }
    if (action === 'uninstall') {
      return [
        buildBrewPlan('bun', action, 'oven-sh/bun/bun', { name: 'Bun' }),
        buildProfileAwareCleanupPlan('bun', 'Bun', ['BUN_INSTALL', '\\.bun/bin'], { trees: ['.bun'] }, options)
      ];
    }
    return [buildBrewPlan('bun', action, 'oven-sh/bun/bun', { name: 'Bun' }), officialScript('bun', action, 'Bun', options)];
  }

  if (toolId === 'pyenv') {
    if (action === 'uninstall') {
      return [
        buildBrewPlan('pyenv', action, 'pyenv', { name: 'Pyenv' }),
        buildProfileAwareCleanupPlan('pyenv', 'Pyenv', ['PYENV_ROOT', 'pyenv init'], { trees: ['.pyenv'] }, options)
      ];
    }
    return [buildBrewPlan('pyenv', action, 'pyenv', { name: 'Pyenv' }), officialScript('pyenv', action, 'Pyenv', options)];
  }

  if (toolId === 'conda') {
    if (action === 'update') return [buildCondaUpdatePlan(options), buildBrewPlan('conda', action, 'miniconda', { name: 'Miniconda', cask: true }), buildMinicondaInstallPlan(action, options)];
    if (action === 'uninstall') return [buildBrewPlan('conda', action, 'miniconda', { name: 'Miniconda', cask: true }), buildCondaCleanupPlan(options)];
    return [buildBrewPlan('conda', action, 'miniconda', { name: 'Miniconda', cask: true }), buildMinicondaInstallPlan(action, options)];
  }

  if (toolId === 'uv') {
    if (action === 'update') return [buildSelfUpdatePlan('uv', 'uv', 'uv', ['self', 'update']), buildBrewPlan('uv', action, 'uv', { name: 'uv' }), officialScript('uv', action, 'uv', options)];
    if (action === 'uninstall') {
      return [
        buildBrewPlan('uv', action, 'uv', { name: 'uv' }),
        buildCommandPlan('uv', 'uninstall', 'uv', ['self', 'uninstall'], {
          id: 'uv_self_uninstall',
          label: 'uv 自卸载',
          method: '内置卸载器',
          effect: '卸载 uv'
        }),
        buildHomeCleanupPlan('uv', 'uv', options, { files: ['.local/bin/uv', '.local/bin/uvx'], trees: ['.local/share/uv'] })
      ];
    }
    return [buildBrewPlan('uv', action, 'uv', { name: 'uv' }), officialScript('uv', action, 'uv', options)];
  }

  if (toolId === 'poetry') {
    if (action === 'update') return [buildSelfUpdatePlan('poetry', 'Poetry', 'poetry', ['self', 'update']), buildBrewPlan('poetry', action, 'poetry', { name: 'Poetry' }), buildPoetryInstallerPlan('install', { ...options, platform: 'macos' })];
    if (action === 'uninstall') return [buildBrewPlan('poetry', action, 'poetry', { name: 'Poetry' }), buildPoetryInstallerPlan('uninstall', { ...options, platform: 'macos' })];
    return [buildBrewPlan('poetry', action, 'poetry', { name: 'Poetry' }), buildPoetryInstallerPlan('install', { ...options, platform: 'macos' })];
  }

  return [];
}

module.exports = {
  resolveMacosEnvironmentPlans
};
