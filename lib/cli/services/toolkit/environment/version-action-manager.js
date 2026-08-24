'use strict';

const nodePath = require('node:path');
const { executeEnvironmentPlan } = require('./plan-executor');
const { resolveHostHome } = require('./probe');

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
  return executeEnvironmentPlan(plan, options);
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
  executeEnvironmentAction,
  planEnvironmentAction,
  runEnvironmentPlan,
  validateEnvironmentName,
  validateVersion
};
