'use strict';

function createAccountCleanupService(options = {}) {
  const {
    fs,
    path,
    profilesDir,
    getProfileDir,
    getAccountStateIndex,
    checkStatus,
    readUsageCache,
    ensureUsageSnapshotAsync,
    getLastUsageProbeError
  } = options;
  const DEFAULT_CLEANUP_JOBS = 1000;
  const CLEANUP_WORKER_SLOT_STALE_MS = 10 * 60 * 1000;
  const CLEANUP_ACCOUNT_LOCK_STALE_MS = 10 * 60 * 1000;
  const CLEANUP_WORKER_SLOT_LIMIT = 256;
  const DEFAULT_WORKER_WARMUP_MS = 120;
  const LOW_REMAINING_DELETE_THRESHOLD_PCT = 10;
  const DEFAULT_PROBE_JOBS = 16;

  function readJsonFileSafe(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_error) {
      return null;
    }
  }

  function decodeBase64UrlJsonSegment(segment) {
    const text = String(segment || '').trim();
    if (!text) return null;
    try {
      const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
      const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
      return JSON.parse(Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8'));
    } catch (_error) {
      return null;
    }
  }

  function decodeJwtPayloadUnsafe(jwt) {
    const text = String(jwt || '').trim();
    if (!text) return null;
    const parts = text.split('.');
    if (parts.length < 2) return null;
    return decodeBase64UrlJsonSegment(parts[1]);
  }

  function normalizeLowerText(value) {
    return String(value || '').trim().toLowerCase();
  }

  function extractJwtAccountId(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const auth = payload['https://api.openai.com/auth'];
    return normalizeLowerText(
      payload.account_id
      || (auth && auth.chatgpt_account_id)
      || (auth && auth.account_id)
      || ''
    );
  }

  function extractJwtPlanType(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const auth = payload['https://api.openai.com/auth'];
    return normalizeLowerText(
      payload.planType
      || payload.plan_type
      || (auth && auth.chatgpt_plan_type)
      || (auth && auth.plan_type)
      || ''
    );
  }

  function extractCodexIdentity(authJson) {
    const tokens = authJson && authJson.tokens && typeof authJson.tokens === 'object'
      ? authJson.tokens
      : null;
    if (!tokens) return { email: '', accountId: '', planType: '' };
    const idPayload = decodeJwtPayloadUnsafe(tokens.id_token);
    const accessPayload = decodeJwtPayloadUnsafe(tokens.access_token);
    const email = String(
      (idPayload && idPayload.email)
      || (accessPayload && accessPayload.email)
      || (accessPayload && accessPayload['https://api.openai.com/profile'] && accessPayload['https://api.openai.com/profile'].email)
      || ''
    ).trim().toLowerCase();
    const accountId = normalizeLowerText(tokens.account_id || extractJwtAccountId(accessPayload) || extractJwtAccountId(idPayload));
    const planType = normalizeLowerText(extractJwtPlanType(accessPayload) || extractJwtPlanType(idPayload));
    return { email, accountId, planType };
  }

  function listNumericDirs(dirPath) {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(a) - Number(b));
  }

  function getMinRemainingPct(cache) {
    if (!cache || typeof cache !== 'object' || !Array.isArray(cache.entries)) return null;
    const values = cache.entries
      .map((entry) => Number(entry && entry.remainingPct))
      .filter((value) => Number.isFinite(value));
    if (values.length === 0) return null;
    return Math.min(...values);
  }

  function isUnauthorizedProbeError(message) {
    const lower = String(message || '').trim().toLowerCase();
    if (!lower) return false;
    return lower.includes('direct_http_status_401')
      || lower.includes('direct_http_status_403')
      || lower.includes('http_401')
      || lower.includes('http_403')
      || lower.includes('invalid_token')
      || lower.includes('unauthorized');
  }

  function normalizeJobs(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return DEFAULT_CLEANUP_JOBS;
    return Math.max(1, Math.floor(num));
  }

  function normalizeProbeJobs(value, upperBound) {
    const hardCap = Math.max(1, Math.min(Number(upperBound) || DEFAULT_PROBE_JOBS, DEFAULT_PROBE_JOBS));
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return hardCap;
    return Math.max(1, Math.min(Math.floor(num), hardCap));
  }

  function getAiHomeDir() {
    return path.dirname(String(profilesDir || '').trim());
  }

  function getCleanupStateDir() {
    return path.join(getAiHomeDir(), 'runtime-locks', 'codex-cleanup');
  }

  function ensureCleanupStateDir() {
    const dir = getCleanupStateDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function isProcessAlive(pid) {
    const num = Number(pid);
    if (!Number.isFinite(num) || num <= 0) return false;
    try {
      process.kill(num, 0);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function readLockInfo(lockPath) {
    return readJsonFileSafe(lockPath);
  }

  function getLockTimestamp(lockInfo) {
    const direct = Number(lockInfo && lockInfo.createdAt);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const claimed = Number(lockInfo && lockInfo.claimedAt);
    if (Number.isFinite(claimed) && claimed > 0) return claimed;
    return 0;
  }

  function isLockStale(lockInfo, staleMs) {
    const createdAt = getLockTimestamp(lockInfo);
    if (!Number.isFinite(createdAt) || createdAt <= 0) return true;
    if (Date.now() - createdAt > staleMs) return true;
    const ownerPid = Number(lockInfo && lockInfo.pid);
    if (Number.isFinite(ownerPid) && ownerPid > 0 && !isProcessAlive(ownerPid)) return true;
    return false;
  }

  function writeLockFile(lockPath, payload) {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  function acquireLock(lockPath, staleMs) {
    const payload = {
      pid: process.pid,
      createdAt: Date.now()
    };
    try {
      writeLockFile(lockPath, payload);
      return true;
    } catch (_error) {}

    try {
      const lockInfo = readLockInfo(lockPath);
      if (isLockStale(lockInfo, staleMs)) {
        fs.unlinkSync(lockPath);
        writeLockFile(lockPath, payload);
        return true;
      }
    } catch (_error) {}

    return false;
  }

  function releaseLock(lockPath) {
    try {
      fs.unlinkSync(lockPath);
    } catch (_error) {}
  }

  function buildBisectionOrder(ids) {
    const list = Array.isArray(ids) ? ids.slice() : [];
    if (list.length <= 2) return list;
    const ordered = [];
    let queue = [{ start: 0, end: list.length - 1 }];
    while (queue.length > 0) {
      const nextQueue = [];
      queue.forEach(({ start, end }) => {
        if (start > end) return;
        const mid = Math.floor((start + end) / 2);
        ordered.push(list[mid]);
        if (start <= mid - 1) nextQueue.push({ start, end: mid - 1 });
        if (mid + 1 <= end) nextQueue.push({ start: mid + 1, end });
      });
      queue = nextQueue;
    }
    return ordered;
  }

  function rotateIds(ids, startIndex) {
    const list = Array.isArray(ids) ? ids.slice() : [];
    if (list.length <= 1) return list;
    const start = ((Number(startIndex) || 0) % list.length + list.length) % list.length;
    if (start === 0) return list;
    return list.slice(start).concat(list.slice(0, start));
  }

  async function sleep(ms) {
    const waitMs = Math.max(0, Number(ms) || 0);
    if (waitMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  function getWorkerSlotsDir() {
    return path.join(ensureCleanupStateDir(), 'workers');
  }

  function acquireWorkerSlot(slotLimit = CLEANUP_WORKER_SLOT_LIMIT) {
    const slotsDir = getWorkerSlotsDir();
    fs.mkdirSync(slotsDir, { recursive: true });
    const limit = Math.max(1, Math.floor(Number(slotLimit) || CLEANUP_WORKER_SLOT_LIMIT));

    for (let slot = 0; slot < limit; slot += 1) {
      const lockPath = path.join(slotsDir, `${slot}.lock`);
      if (!acquireLock(lockPath, CLEANUP_WORKER_SLOT_STALE_MS)) continue;
      return {
        slot,
        slotLimit: limit,
        release: () => releaseLock(lockPath)
      };
    }

    return {
      slot: -1,
      slotLimit: limit,
      release: () => {}
    };
  }

  function listActiveWorkerSlots(slotLimit = CLEANUP_WORKER_SLOT_LIMIT) {
    const slotsDir = getWorkerSlotsDir();
    if (!fs.existsSync(slotsDir)) return [];
    const limit = Math.max(1, Math.floor(Number(slotLimit) || CLEANUP_WORKER_SLOT_LIMIT));
    const active = [];
    for (let slot = 0; slot < limit; slot += 1) {
      const lockPath = path.join(slotsDir, `${slot}.lock`);
      if (!fs.existsSync(lockPath)) continue;
      try {
        const info = readLockInfo(lockPath);
        if (isLockStale(info, CLEANUP_WORKER_SLOT_STALE_MS)) {
          fs.unlinkSync(lockPath);
          continue;
        }
        active.push(slot);
      } catch (_error) {}
    }
    return active.sort((a, b) => a - b);
  }

  function buildWorkerShard(ids, workerSlot, slotLimit = CLEANUP_WORKER_SLOT_LIMIT) {
    const ordered = Array.isArray(ids) ? ids.slice() : [];
    if (ordered.length <= 1) {
      return {
        activeSlots: workerSlot >= 0 ? [workerSlot] : [],
        workerRank: 0,
        workerCount: workerSlot >= 0 ? 1 : 0,
        startIndex: 0,
        shardIds: ordered
      };
    }

    const activeSlots = listActiveWorkerSlots(slotLimit);
    if (Number.isFinite(workerSlot) && workerSlot >= 0 && !activeSlots.includes(workerSlot)) {
      activeSlots.push(workerSlot);
      activeSlots.sort((a, b) => a - b);
    }
    const workerCount = Math.max(1, activeSlots.length || 1);
    const workerRank = Math.max(0, activeSlots.indexOf(workerSlot));
    const startIndex = workerRank;
    const shardIds = ordered.filter((_id, index) => index % workerCount === workerRank);
    return {
      activeSlots,
      workerRank,
      workerCount,
      startIndex,
      shardIds: shardIds.length > 0 ? shardIds : ordered
    };
  }

  function tryClaimAccount(id) {
    const stateDir = ensureCleanupStateDir();
    const claimsDir = path.join(stateDir, 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const lockPath = path.join(claimsDir, `${String(id)}.lock`);
    if (!acquireLock(lockPath, CLEANUP_ACCOUNT_LOCK_STALE_MS)) return null;
    return () => releaseLock(lockPath);
  }

  function listCliAccountIds(cliName) {
    const toolDir = path.join(profilesDir, String(cliName || '').trim());
    return listNumericDirs(toolDir);
  }

  function parseDeleteSelectorTokens(tokens) {
    const items = Array.isArray(tokens) ? tokens : [];
    const ids = [];
    items.forEach((tokenRaw) => {
      const token = String(tokenRaw || '').trim();
      if (!token) return;
      token.split(',').forEach((partRaw) => {
        const part = String(partRaw || '').trim();
        if (!part) return;
        if (/^\d+$/.test(part)) {
          ids.push(part);
          return;
        }
        const rangeMatch = part.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
          const start = Number(rangeMatch[1]);
          const end = Number(rangeMatch[2]);
          if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0 || start > end) {
            throw new Error(`invalid_delete_selector:${part}`);
          }
          for (let current = start; current <= end; current += 1) {
            ids.push(String(current));
          }
          return;
        }
        throw new Error(`invalid_delete_selector:${part}`);
      });
    });
    return Array.from(new Set(ids)).sort((a, b) => Number(a) - Number(b));
  }

  function deleteAccountsForCli(cliName, ids) {
    const provider = String(cliName || '').trim();
    if (!provider) {
      return { provider, requestedIds: [], deletedIds: [], missingIds: [] };
    }
    const requestedIds = Array.isArray(ids) ? ids.filter((id) => /^\d+$/.test(String(id || ''))) : [];
    const deletedIds = [];
    const missingIds = [];
    const accountStateIndex = typeof getAccountStateIndex === 'function' ? getAccountStateIndex() : null;

    requestedIds.forEach((id) => {
      const profileDir = getProfileDir(provider, id);
      if (!fs.existsSync(profileDir)) {
        missingIds.push(String(id));
        return;
      }
      fs.rmSync(profileDir, { recursive: true, force: true });
      if (accountStateIndex && typeof accountStateIndex.deleteAccountState === 'function') {
        accountStateIndex.deleteAccountState(provider, String(id));
      }
      deletedIds.push(String(id));
    });

    return { provider, requestedIds, deletedIds, missingIds };
  }

  function deleteAllAccountsForCli(cliName) {
    const ids = listCliAccountIds(cliName);
    const result = deleteAccountsForCli(cliName, ids);
    return { ...result, totalBeforeDelete: ids.length };
  }

  function isFreeOauthAccount(profileDir) {
    return !fs.existsSync(path.join(profileDir, '.aih_env.json'));
  }

  function hasCachedRemainingZero(cache) {
    const remainingPct = getMinRemainingPct(cache);
    return Number.isFinite(remainingPct) && remainingPct <= 0;
  }

  function hasKnownRemaining(cache) {
    return Number.isFinite(getMinRemainingPct(cache));
  }

  function isLowRemaining(cache, thresholdPct = LOW_REMAINING_DELETE_THRESHOLD_PCT) {
    const remainingPct = getMinRemainingPct(cache);
    return Number.isFinite(remainingPct) && remainingPct > 0 && remainingPct < thresholdPct;
  }

  async function inspectCodexAccount(id) {
    const profileDir = getProfileDir('codex', id);
    if (!isFreeOauthAccount(profileDir)) {
      return { id, skipped: true };
    }

    const reasons = [];
    const identity = extractCodexIdentity(readJsonFileSafe(path.join(profileDir, '.codex', 'auth.json')));
    const status = checkStatus('codex', profileDir);
    if (!status || !status.configured) {
      reasons.push('status_401');
    } else {
      const initialCache = readUsageCache('codex', id);
      if (hasCachedRemainingZero(initialCache)) {
        reasons.push('remaining_0');
      } else if (identity.planType === 'free' && isLowRemaining(initialCache)) {
        reasons.push(`remaining_lt_${LOW_REMAINING_DELETE_THRESHOLD_PCT}_free`);
      } else if (!hasKnownRemaining(initialCache)) {
        try {
          const refreshed = await ensureUsageSnapshotAsync('codex', id, initialCache, { forceRefresh: true });
          if (hasCachedRemainingZero(refreshed)) {
            reasons.push('remaining_0');
          } else if (identity.planType === 'free' && isLowRemaining(refreshed)) {
            reasons.push(`remaining_lt_${LOW_REMAINING_DELETE_THRESHOLD_PCT}_free`);
          }
        } catch (error) {
          if (isUnauthorizedProbeError(error && error.message)) {
            reasons.push('status_401');
          } else {
            throw error;
          }
        }
      }
      const probeError = typeof getLastUsageProbeError === 'function'
        ? getLastUsageProbeError('codex', id)
        : '';
      if (isUnauthorizedProbeError(probeError)) {
        reasons.push('status_401');
      }
    }

    if (reasons.length === 0) {
      return { id, skipped: true };
    }

    return {
      id,
      skipped: false,
      profileDir,
      reasons: Array.from(new Set(reasons)),
      email: identity.email || '',
      accountId: identity.accountId || '',
      planType: identity.planType || ''
    };
  }

  function classifyCleanupAccount(id) {
    const profileDir = getProfileDir('codex', id);
    if (!isFreeOauthAccount(profileDir)) {
      return { id, skip: true, needsProbe: false };
    }
    const status = checkStatus('codex', profileDir);
    if (!status || !status.configured) {
      return { id, skip: false, needsProbe: false };
    }
    const cache = readUsageCache('codex', id);
    return {
      id,
      skip: false,
      needsProbe: !hasKnownRemaining(cache),
      cacheKnown: hasKnownRemaining(cache)
    };
  }

  async function runWithConcurrency(items, concurrency, worker) {
    const list = Array.isArray(items) ? items : [];
    const size = Math.min(Math.max(1, concurrency), Math.max(1, list.length));
    const results = new Array(list.length);
    let nextIndex = 0;

    async function runWorker() {
      while (true) {
        const current = nextIndex;
        nextIndex += 1;
        if (current >= list.length) return;
        results[current] = await worker(list[current], current);
      }
    }

    await Promise.all(Array.from({ length: size }, () => runWorker()));
    return results;
  }

  async function cleanupCodexAccounts(runOptions = {}) {
    const toolDir = path.join(profilesDir, 'codex');
    const ids = listNumericDirs(toolDir);
    const jobs = normalizeJobs(runOptions.jobs);
    const onScanProgress = typeof runOptions.onScanProgress === 'function' ? runOptions.onScanProgress : null;
    const onDelete = typeof runOptions.onDelete === 'function' ? runOptions.onDelete : null;
    const removedAccounts = [];
    const accountStateIndex = typeof getAccountStateIndex === 'function' ? getAccountStateIndex() : null;
    let scanned = 0;
    let lockedSkipped = 0;

    const freeIds = ids.filter((id) => isFreeOauthAccount(getProfileDir('codex', id)));
    const orderedIds = buildBisectionOrder(freeIds);
    const workerLease = acquireWorkerSlot(runOptions.workerSlotLimit);
    const workerWarmupMs = Number.isFinite(Number(runOptions.workerWarmupMs))
      ? Math.max(0, Number(runOptions.workerWarmupMs))
      : DEFAULT_WORKER_WARMUP_MS;
    if (workerLease.slot >= 0 && orderedIds.length > 1 && workerWarmupMs > 0) {
      await sleep(workerWarmupMs);
    }
    const shard = buildWorkerShard(orderedIds, workerLease.slot, workerLease.slotLimit);
    const rotatedIds = rotateIds(shard.shardIds, shard.startIndex);
    if (onScanProgress) {
      onScanProgress({
        scanned: 0,
        total: freeIds.length,
        id: '',
        matched: false,
        deleted: 0,
        lockedSkipped: 0,
        startIndex: shard.startIndex,
        orderMode: 'bisection',
        workerSlot: workerLease.slot,
        workerRank: shard.workerRank,
        workerCount: shard.workerCount
      });
    }
    const probeJobs = normalizeProbeJobs(runOptions.probeJobs, jobs);
    const fastIds = [];
    const probeIds = [];
    rotatedIds.forEach((id) => {
      const classified = classifyCleanupAccount(id);
      if (classified.skip) return;
      if (classified.needsProbe) probeIds.push(id);
      else fastIds.push(id);
    });

    async function processId(id) {
      const releaseClaim = tryClaimAccount(id);
      if (!releaseClaim) {
        scanned += 1;
        lockedSkipped += 1;
        if (onScanProgress) {
          onScanProgress({
            scanned,
            total: freeIds.length,
            id,
            matched: false,
            reasons: [],
            locked: true,
            deleted: removedAccounts.length,
            lockedSkipped,
            startIndex: shard.startIndex,
            orderMode: 'bisection',
            workerSlot: workerLease.slot,
            workerRank: shard.workerRank,
            workerCount: shard.workerCount
          });
        }
        return { id, skipped: true, locked: true };
      }

      try {
        const result = await inspectCodexAccount(id);
        if (result && !result.skipped) {
          if (fs.existsSync(result.profileDir)) {
            fs.rmSync(result.profileDir, { recursive: true, force: true });
          }
          if (accountStateIndex && typeof accountStateIndex.deleteAccountState === 'function') {
            accountStateIndex.deleteAccountState('codex', result.id);
          }
          const removed = {
            id: result.id,
            reasons: result.reasons,
            email: result.email,
            accountId: result.accountId,
            planType: result.planType || ''
          };
          removedAccounts.push(removed);
          if (onDelete) onDelete(removed);
        }
        scanned += 1;
        if (onScanProgress) {
          onScanProgress({
            scanned,
            total: freeIds.length,
            id,
            matched: !result.skipped,
            reasons: result.reasons || [],
            deleted: removedAccounts.length,
            lockedSkipped,
            startIndex: shard.startIndex,
            orderMode: 'bisection',
            workerSlot: workerLease.slot,
            workerRank: shard.workerRank,
            workerCount: shard.workerCount
          });
        }
        return result;
      } finally {
        releaseClaim();
      }
    }

    try {
      await runWithConcurrency(fastIds, jobs, processId);
      await runWithConcurrency(probeIds, probeJobs, processId);
    } finally {
      workerLease.release();
    }
    removedAccounts.sort((a, b) => Number(a.id) - Number(b.id));

    return {
      provider: 'codex',
      jobs,
      scannedAccounts: freeIds.length,
      startIndex: shard.startIndex,
      orderMode: 'bisection',
      workerSlot: workerLease.slot,
      workerRank: shard.workerRank,
      workerCount: shard.workerCount,
      lockedSkipped,
      removedAccounts,
      removedCliproxyapiFiles: []
    };
  }

  return {
    cleanupCodexAccounts,
    parseDeleteSelectorTokens,
    deleteAccountsForCli,
    deleteAllAccountsForCli
  };
}

module.exports = {
  createAccountCleanupService
};
