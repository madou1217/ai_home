'use strict';

function isManagedCodexStopHook(hook, scriptName) {
  const name = String(scriptName || '').trim();
  return Boolean(name) && String(hook && hook.command || '').includes(name);
}

function hasManagedCodexStopHook(stopHooks, scriptName) {
  return (Array.isArray(stopHooks) ? stopHooks : []).some((group) =>
    Array.isArray(group && group.hooks)
    && group.hooks.some((hook) => isManagedCodexStopHook(hook, scriptName))
  );
}

function createManagedCodexStopHookGroup(commandValue) {
  return {
    hooks: [
      {
        type: 'command',
        command: commandValue,
        timeout: 10
      }
    ]
  };
}

function normalizeManagedCodexStopHooks(stopHooks, scriptName) {
  let changed = false;
  const hooks = (Array.isArray(stopHooks) ? stopHooks : []).map((group) => {
    if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
      return group;
    }
    const nextHooks = group.hooks.map((hook) => {
      const shouldNormalize = isManagedCodexStopHook(hook, scriptName)
        && hook
        && typeof hook === 'object'
        && Object.prototype.hasOwnProperty.call(hook, 'statusMessage');
      if (!shouldNormalize) {
        return hook;
      }
      const nextHook = { ...hook };
      delete nextHook.statusMessage;
      changed = true;
      return nextHook;
    });
    return { ...group, hooks: nextHooks };
  });
  return { hooks, changed };
}

module.exports = {
  createManagedCodexStopHookGroup,
  hasManagedCodexStopHook,
  normalizeManagedCodexStopHooks
};
