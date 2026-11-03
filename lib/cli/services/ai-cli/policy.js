'use strict';

function createCodexPolicyService(options = {}) {
  const {
    aiHomeDir,
    loadPermissionPolicy,
    savePermissionPolicy,
    shouldUseDangerFullAccess
  } = options;

  function getEffectiveExecSandbox(policy) {
    if (shouldUseDangerFullAccess(policy)) return 'danger-full-access';
    return policy.exec.defaultSandbox;
  }

  function showCodexPolicy() {
    const policy = loadPermissionPolicy({ aiHomeDir });
    console.log(`default_sandbox: ${policy.exec.defaultSandbox}`);
    console.log(`allow_danger_full_access: ${policy.exec.allowDangerFullAccess}`);
    console.log(`effective_exec_sandbox: ${getEffectiveExecSandbox(policy)}`);
  }

  function setCodexPolicy(rawSandbox) {
    const sandbox = String(rawSandbox || '').trim().toLowerCase();
    if (!sandbox) {
      throw new Error('Missing sandbox value. Use: policy set <workspace-write|read-only|danger-full-access>');
    }
    if (!['workspace-write', 'read-only', 'danger-full-access'].includes(sandbox)) {
      throw new Error(`Invalid sandbox value '${rawSandbox}'. Expected workspace-write, read-only, or danger-full-access.`);
    }

    const current = loadPermissionPolicy({ aiHomeDir });
    const next = {
      ...current,
      exec: {
        ...current.exec,
        defaultSandbox: sandbox,
        allowDangerFullAccess: sandbox === 'danger-full-access'
      }
    };
    const saved = savePermissionPolicy(next, { aiHomeDir });
    console.log(`default_sandbox: ${saved.exec.defaultSandbox}`);
    console.log(`allow_danger_full_access: ${saved.exec.allowDangerFullAccess}`);
    console.log(`effective_exec_sandbox: ${getEffectiveExecSandbox(saved)}`);
  }

  return {
    getEffectiveExecSandbox,
    showCodexPolicy,
    setCodexPolicy
  };
}

module.exports = {
  createCodexPolicyService
};
