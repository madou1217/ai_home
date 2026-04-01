'use strict';

function createAccountSelectionService(options = {}) {
  const {
    path,
    fs,
    profilesDir,
    getAccountStateIndex,
    getProfileDir,
    getToolAccountIds,
    checkStatus,
    syncExhaustedStateFromUsage,
    isExhausted,
    stateIndexClient,
    ensureUsageSnapshot,
    readUsageCache,
    getUsageRemainingPercentValues
  } = options;

  function getNextAvailableId(cliName, currentId) {
    const current = String(currentId || '').trim();
    for (let i = 0; i < 128; i += 1) {
      const indexedCandidate = getAccountStateIndex().getNextCandidateId(cliName, current);
      if (!indexedCandidate) break;
      const profileDir = getProfileDir(cliName, indexedCandidate);
      if (!fs.existsSync(profileDir)) {
        getToolAccountIds(cliName);
        continue;
      }
      const { configured, accountName } = checkStatus(cliName, profileDir);
      const apiKeyMode = !!(accountName && accountName.startsWith('API Key'));
      const usageExhausted = syncExhaustedStateFromUsage(cliName, indexedCandidate);
      const exhausted = usageExhausted === true || isExhausted(cliName, indexedCandidate);
      stateIndexClient.upsert(cliName, indexedCandidate, {
        configured,
        apiKeyMode,
        exhausted
      });
      if (configured && !apiKeyMode && !exhausted) {
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
          exhausted: false
        });
        return;
      }
      const usageExhausted = syncExhaustedStateFromUsage(cliName, id);
      const exhausted = usageExhausted === true || isExhausted(cliName, id);
      let remaining = -1;
      const cache = ensureUsageSnapshot(cliName, id, readUsageCache(cliName, id));
      const values = getUsageRemainingPercentValues(cache);
      if (values.length > 0) remaining = Math.min(...values);
      stateIndexClient.upsert(cliName, id, {
        configured: true,
        apiKeyMode: false,
        exhausted,
        remainingPct: values.length > 0 ? remaining : null
      });
      if (exhausted) return;
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
