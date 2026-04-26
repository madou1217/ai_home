'use strict';

function createAccountSelectionService(options = {}) {
  const {
    path,
    fs,
    profilesDir,
    getAccountStateIndex,
    getToolAccountIds,
    checkStatus,
    stateIndexClient,
    refreshIndexedStateForAccount
  } = options;

  function getNextAvailableId(cliName, currentId) {
    const current = String(currentId || '').trim();
    for (let i = 0; i < 128; i += 1) {
      const indexedCandidate = getAccountStateIndex().getNextCandidateId(cliName, current);
      if (!indexedCandidate) break;
      const profileDir = path.join(profilesDir, cliName, indexedCandidate);
      if (!fs.existsSync(profileDir)) {
        getToolAccountIds(cliName);
        continue;
      }
      const derivedState = refreshIndexedStateForAccount(cliName, indexedCandidate, { refreshSnapshot: true });
      const configured = Boolean(derivedState && derivedState.configured);
      const apiKeyMode = Boolean(derivedState && derivedState.apiKeyMode);
      const schedulable = String(derivedState && derivedState.schedulableStatus || '') === 'schedulable';
      stateIndexClient.upsert(cliName, indexedCandidate, {
        configured,
        apiKeyMode,
        remainingPct: derivedState ? derivedState.remainingPct : null,
        displayName: derivedState ? derivedState.displayName : null
      });
      if (configured && !apiKeyMode && schedulable) {
        return indexedCandidate;
      }
    }

    const toolDir = path.join(profilesDir, cliName);
    if (!fs.existsSync(toolDir)) return null;
    const ids = fs.readdirSync(toolDir)
      .filter((f) => /^\d+$/.test(f) && fs.statSync(path.join(toolDir, f)).isDirectory());

    let bestId = null;
    let bestRemaining = -1;
    ids.forEach((id) => {
      if (id === current) return;
      const profileDir = path.join(toolDir, id);
      const { configured, accountName } = checkStatus(cliName, profileDir);
      const apiKeyMode = !!(accountName && accountName.startsWith('API Key'));
      if (!configured || apiKeyMode) {
        stateIndexClient.upsert(cliName, id, {
          configured,
          apiKeyMode,
          remainingPct: null
        });
        return;
      }
      const derivedState = refreshIndexedStateForAccount(cliName, id, { refreshSnapshot: true });
      const remaining = derivedState && Number.isFinite(Number(derivedState.remainingPct))
        ? Number(derivedState.remainingPct)
        : -1;
      stateIndexClient.upsert(cliName, id, {
        configured: true,
        apiKeyMode: false,
        remainingPct: remaining >= 0 ? remaining : null,
        displayName: derivedState ? derivedState.displayName : null
      });
      if (!derivedState || derivedState.schedulableStatus !== 'schedulable') return;
      if (remaining > bestRemaining) {
        bestRemaining = remaining;
        bestId = id;
        return;
      }
      if (remaining === bestRemaining && bestId !== null && Number(id) < Number(bestId)) {
        bestId = id;
      }
      if (bestId === null) bestId = id;
    });

    return bestId;
  }

  return {
    getNextAvailableId
  };
}

module.exports = {
  createAccountSelectionService
};
