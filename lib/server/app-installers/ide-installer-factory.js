'use strict';

const { createProviderInstaller } = require('./provider-factory');
const { buildShellPlan, shellQuote } = require('./official-install');

const IDE_ACTION_LABELS = Object.freeze({
  install: '安装',
  update: '更新',
  uninstall: '卸载'
});

function validateLinuxRepository(repository = {}) {
  const packageName = String(repository.packageName || '').trim();
  if (!/^[a-z0-9][a-z0-9+._-]*$/i.test(packageName)) {
    throw new Error('invalid_ide_linux_package');
  }
  for (const manager of ['apt', 'rpm']) {
    const source = repository[manager] || {};
    for (const field of ['keyUrl', 'repository', 'repositoryPath']) {
      if (!String(source[field] || '').trim()) throw new Error(`missing_ide_${manager}_${field}`);
    }
    const keyUrl = new URL(String(source.keyUrl));
    if (keyUrl.protocol !== 'https:') throw new Error(`invalid_ide_${manager}_key_url`);
  }
  if (!String(repository.apt.keyPath || '').trim()) throw new Error('missing_ide_apt_key_path');
  return { ...repository, packageName };
}

function rootCommandFunction() {
  return 'run_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }';
}

function buildAptInstallSteps(repository) {
  const apt = repository.apt;
  return [
    'command -v curl >/dev/null 2>&1',
    'command -v gpg >/dev/null 2>&1',
    'tmp_dir="$(mktemp -d -t aih-ide.XXXXXX)"',
    'trap \'rm -rf "$tmp_dir"\' EXIT',
    `curl -fsSL ${shellQuote(apt.keyUrl)} -o "$tmp_dir/key.asc"`,
    'gpg --batch --yes --dearmor -o "$tmp_dir/key.gpg" "$tmp_dir/key.asc"',
    `printf '%s\n' ${shellQuote(apt.repository)} > "$tmp_dir/repository.list"`,
    `run_root install -d -m 0755 ${shellQuote(require('node:path').posix.dirname(apt.keyPath))}`,
    `run_root install -m 0644 "$tmp_dir/key.gpg" ${shellQuote(apt.keyPath)}`,
    `run_root install -m 0644 "$tmp_dir/repository.list" ${shellQuote(apt.repositoryPath)}`,
    'run_root apt-get update',
    `run_root apt-get install -y ${shellQuote(repository.packageName)}`
  ];
}

function buildRpmInstallSteps(repository) {
  const rpm = repository.rpm;
  return [
    'tmp_dir="$(mktemp -d -t aih-ide.XXXXXX)"',
    'trap \'rm -rf "$tmp_dir"\' EXIT',
    `printf '%s\n' ${shellQuote(rpm.repository)} > "$tmp_dir/repository.repo"`,
    `run_root rpm --import ${shellQuote(rpm.keyUrl)}`,
    `run_root install -m 0644 "$tmp_dir/repository.repo" ${shellQuote(rpm.repositoryPath)}`,
    'if command -v dnf >/dev/null 2>&1; then package_manager=dnf; else package_manager=yum; fi',
    `run_root "$package_manager" install -y ${shellQuote(repository.packageName)}`
  ];
}

function buildLinuxInstallScript(repository) {
  return [
    rootCommandFunction(),
    'if command -v apt-get >/dev/null 2>&1; then',
    ...buildAptInstallSteps(repository).map((line) => `  ${line}`),
    'elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then',
    ...buildRpmInstallSteps(repository).map((line) => `  ${line}`),
    'else',
    '  echo "当前 Linux 没有受支持的 apt、dnf 或 yum 包管理器" >&2',
    '  exit 64',
    'fi'
  ].join('\n');
}

function buildLinuxUpdateScript(repository) {
  return [
    rootCommandFunction(),
    'if command -v apt-get >/dev/null 2>&1; then',
    '  run_root apt-get update',
    `  run_root apt-get install -y --only-upgrade ${shellQuote(repository.packageName)}`,
    'elif command -v dnf >/dev/null 2>&1; then',
    `  run_root dnf upgrade -y ${shellQuote(repository.packageName)}`,
    'elif command -v yum >/dev/null 2>&1; then',
    `  run_root yum update -y ${shellQuote(repository.packageName)}`,
    'else',
    '  echo "当前 Linux 没有受支持的 apt、dnf 或 yum 包管理器" >&2',
    '  exit 64',
    'fi'
  ].join('\n');
}

function buildLinuxUninstallScript(repository) {
  return [
    rootCommandFunction(),
    'if command -v apt-get >/dev/null 2>&1; then',
    `  run_root apt-get remove -y ${shellQuote(repository.packageName)}`,
    `  run_root rm -f ${shellQuote(repository.apt.repositoryPath)} ${shellQuote(repository.apt.keyPath)}`,
    'elif command -v dnf >/dev/null 2>&1; then',
    `  run_root dnf remove -y ${shellQuote(repository.packageName)}`,
    `  run_root rm -f ${shellQuote(repository.rpm.repositoryPath)}`,
    'elif command -v yum >/dev/null 2>&1; then',
    `  run_root yum remove -y ${shellQuote(repository.packageName)}`,
    `  run_root rm -f ${shellQuote(repository.rpm.repositoryPath)}`,
    'else',
    '  echo "当前 Linux 没有受支持的 apt、dnf 或 yum 包管理器" >&2',
    '  exit 64',
    'fi'
  ].join('\n');
}

function buildLinuxRepositoryPlan(appId, name, action, repositoryInput) {
  const repository = validateLinuxRepository(repositoryInput);
  const script = action === 'install'
    ? buildLinuxInstallScript(repository)
    : action === 'update'
      ? buildLinuxUpdateScript(repository)
      : buildLinuxUninstallScript(repository);
  return buildShellPlan(
    `${appId}_linux_${action}`,
    `${IDE_ACTION_LABELS[action]} ${name}`,
    script
  );
}

function createIdeInstaller({
  id,
  name,
  cask,
  wingetId,
  windowsDisplayNames = [],
  linuxRepository
}) {
  const appId = String(id || '').trim().toLowerCase();
  const displayName = String(name || appId).trim();
  const repository = validateLinuxRepository(linuxRepository);
  return createProviderInstaller({
    provider: appId,
    desktop: {
      macos: { cask },
      windows: { wingetId, windowsDisplayNames },
      linux: {
        linuxPackages: [repository.packageName],
        resolveInstallPlans: () => [buildLinuxRepositoryPlan(appId, displayName, 'install', repository)],
        resolveUpdatePlans: () => [buildLinuxRepositoryPlan(appId, displayName, 'update', repository)],
        resolveUninstallPlans: () => [buildLinuxRepositoryPlan(appId, displayName, 'uninstall', repository)]
      }
    }
  });
}

module.exports = {
  buildLinuxRepositoryPlan,
  createIdeInstaller,
  validateLinuxRepository
};
