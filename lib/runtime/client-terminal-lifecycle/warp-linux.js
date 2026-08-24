'use strict';

const { buildLinuxAppImagePlans } = require('./linux-appimage');

const WARP_PACKAGE_NAME = 'warp-terminal';
const WARP_KEY_URL = 'https://releases.warp.dev/linux/keys/warp.asc';
const WARP_APT_KEY_PATH = '/usr/share/keyrings/warpdotdev.gpg';
const WARP_APT_REPOSITORY_PATH = '/etc/apt/sources.list.d/warpdotdev.list';
const WARP_APT_REPOSITORY = `deb [arch=amd64 signed-by=${WARP_APT_KEY_PATH}] https://releases.warp.dev/linux/deb stable main`;
const WARP_RPM_REPOSITORY_PATH = '/etc/yum.repos.d/warpdotdev.repo';
const WARP_RPM_REPOSITORY = [
  '[warpdotdev]',
  'name=Warp',
  'baseurl=https://releases.warp.dev/linux/rpm/stable/$basearch',
  'enabled=1',
  'gpgcheck=1',
  `gpgkey=${WARP_KEY_URL}`
].join('\n');

const ACTION_LABELS = Object.freeze({
  install: '安装 Warp',
  update: '更新 Warp',
  uninstall: '卸载 Warp'
});

function shellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "'\\''")}'`;
}

function rootScript(lines) {
  return [
    'set -eu',
    'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"',
    'run_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }',
    ...lines
  ].join('\n');
}

function buildAptInstallScript() {
  return rootScript([
    'run_root apt-get install -y wget gpg',
    'tmp_dir="$(mktemp -d -t aih-warp.XXXXXX)"',
    'trap \'rm -rf "$tmp_dir"\' EXIT',
    `wget -qO "$tmp_dir/warp.asc" ${shellQuote(WARP_KEY_URL)}`,
    'gpg --batch --yes --dearmor -o "$tmp_dir/warpdotdev.gpg" "$tmp_dir/warp.asc"',
    `printf '%s\\n' ${shellQuote(WARP_APT_REPOSITORY)} > "$tmp_dir/warpdotdev.list"`,
    `run_root install -D -o root -g root -m 0644 "$tmp_dir/warpdotdev.gpg" ${shellQuote(WARP_APT_KEY_PATH)}`,
    `run_root install -D -o root -g root -m 0644 "$tmp_dir/warpdotdev.list" ${shellQuote(WARP_APT_REPOSITORY_PATH)}`,
    'run_root apt-get update',
    `run_root apt-get install -y ${WARP_PACKAGE_NAME}`
  ]);
}

function buildRpmInstallScript(packageManager) {
  return rootScript([
    'tmp_dir="$(mktemp -d -t aih-warp.XXXXXX)"',
    'trap \'rm -rf "$tmp_dir"\' EXIT',
    `printf '%s\\n' ${shellQuote(WARP_RPM_REPOSITORY)} > "$tmp_dir/warpdotdev.repo"`,
    `run_root rpm --import ${shellQuote(WARP_KEY_URL)}`,
    `run_root install -D -o root -g root -m 0644 "$tmp_dir/warpdotdev.repo" ${shellQuote(WARP_RPM_REPOSITORY_PATH)}`,
    `run_root ${packageManager} install -y ${WARP_PACKAGE_NAME}`
  ]);
}

const PACKAGE_MANAGER_STRATEGIES = Object.freeze([
  Object.freeze({
    id: 'apt',
    commands: Object.freeze(['apt-get']),
    fallbackPaths: Object.freeze(['/usr/bin/apt-get', '/usr/local/bin/apt-get']),
    scripts: Object.freeze({
      install: buildAptInstallScript(),
      update: rootScript([
        'run_root apt-get update',
        `run_root apt-get install -y --only-upgrade ${WARP_PACKAGE_NAME}`
      ]),
      uninstall: rootScript([`run_root apt-get remove -y ${WARP_PACKAGE_NAME}`])
    })
  }),
  Object.freeze({
    id: 'dnf',
    commands: Object.freeze(['dnf']),
    fallbackPaths: Object.freeze(['/usr/bin/dnf', '/usr/local/bin/dnf']),
    scripts: Object.freeze({
      install: buildRpmInstallScript('dnf'),
      update: rootScript([`run_root dnf upgrade -y ${WARP_PACKAGE_NAME}`]),
      uninstall: rootScript([`run_root dnf remove -y ${WARP_PACKAGE_NAME}`])
    })
  }),
  Object.freeze({
    id: 'yum',
    commands: Object.freeze(['yum']),
    fallbackPaths: Object.freeze(['/usr/bin/yum', '/usr/local/bin/yum']),
    scripts: Object.freeze({
      install: buildRpmInstallScript('yum'),
      update: rootScript([`run_root yum update -y ${WARP_PACKAGE_NAME}`]),
      uninstall: rootScript([`run_root yum remove -y ${WARP_PACKAGE_NAME}`])
    })
  })
]);

function resolvePackageManager(context, resolveExecutable) {
  if (typeof resolveExecutable !== 'function') return null;
  for (const strategy of PACKAGE_MANAGER_STRATEGIES) {
    const executable = resolveExecutable(strategy.commands, strategy.fallbackPaths, context);
    if (executable) return strategy;
  }
  return null;
}

function buildWarpLinuxPlans(context = {}, dependencies = {}) {
  const strategy = resolvePackageManager(context, dependencies.resolveExecutable);
  if (!strategy) {
    return buildLinuxAppImagePlans({
      label: 'Warp',
      executableName: 'warp-terminal',
      packageNames: [WARP_PACKAGE_NAME],
      context,
      resolveUrlScript: "url='https://app.warp.dev/download?package=appimage'"
    });
  }
  return ['install', 'update', 'uninstall'].map((action) => ({
    action,
    label: ACTION_LABELS[action],
    packageManager: strategy.id,
    file: '/bin/sh',
    args: ['-c', strategy.scripts[action]]
  }));
}

module.exports = {
  buildWarpLinuxPlans
};
