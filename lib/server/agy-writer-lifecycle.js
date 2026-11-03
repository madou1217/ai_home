'use strict';

function normalizeAccountRef(accountRef) {
  return String(accountRef || '').trim();
}

function createWriterLifecycleCoordinator(options = {}) {
  const isWriterAlive = typeof options.isWriterAlive === 'function'
    ? options.isWriterAlive
    : () => false;
  const terminateWriter = typeof options.terminateWriter === 'function'
    ? options.terminateWriter
    : () => {};
  const waitForPoll = typeof options.waitForPoll === 'function'
    ? options.waitForPoll
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const pollIntervalMs = Math.max(1, Number(options.pollIntervalMs) || 25);
  // 每个 accountRef 独立维护 generation：pending 先占位，live 再绑定 child。
  // quiescing 与 writers 分开记录，避免 kill 已发出但 PID 尚存时出现“无 writer”假象。
  const accounts = new Map();

  function getState(accountRef, create = false) {
    const normalizedRef = normalizeAccountRef(accountRef);
    if (!normalizedRef) return null;
    let state = accounts.get(normalizedRef);
    if (!state && create) {
      state = {
        accountRef: normalizedRef,
        nextGeneration: 0,
        coordinatedGeneration: 0,
        writers: new Map(),
        quiescing: null
      };
      accounts.set(normalizedRef, state);
    }
    return state || null;
  }

  function cleanState(state) {
    if (!state || state.quiescing || state.writers.size > 0) return;
    accounts.delete(state.accountRef);
  }

  function getRecord(lease) {
    if (!lease) return null;
    const state = getState(lease.accountRef);
    if (!state) return null;
    const record = state.writers.get(Number(lease.generation));
    return record && record.lease === lease ? record : null;
  }

  function isRecordActive(record) {
    return Boolean(record && (
      record.phase === 'pending'
      || (record.phase === 'live' && record.writer && isWriterAlive(record.writer))
    ));
  }

  function reserve(accountRef) {
    const state = getState(accountRef, true);
    if (!state) {
      const error = new Error('agy_writer_account_ref_required');
      error.code = 'agy_writer_account_ref_required';
      throw error;
    }
    const lease = Object.freeze({
      accountRef: state.accountRef,
      generation: state.nextGeneration + 1
    });
    state.nextGeneration = lease.generation;
    state.writers.set(lease.generation, {
      lease,
      phase: 'pending',
      writer: null
    });
    return lease;
  }

  function activate(lease, writer) {
    const record = getRecord(lease);
    if (!record || !writer) return false;
    record.phase = 'live';
    record.writer = writer;
    return true;
  }

  function release(lease) {
    const state = lease && getState(lease.accountRef);
    const record = getRecord(lease);
    if (!state || !record) return false;
    const hasNewerRecord = [...state.writers.keys()]
      .some((generation) => generation > lease.generation);
    state.writers.delete(lease.generation);
    const hasOtherActiveWriter = [...state.writers.values()].some(isRecordActive);
    const finalWriter = !hasNewerRecord
      && !hasOtherActiveWriter
      && state.coordinatedGeneration < lease.generation;
    if (finalWriter) state.coordinatedGeneration = lease.generation;
    cleanState(state);
    return finalWriter;
  }

  function hasWriter(accountRef) {
    const state = getState(accountRef);
    if (!state) return false;
    if (state.quiescing) return true;
    for (const record of state.writers.values()) {
      if (isRecordActive(record)) return true;
    }
    return false;
  }

  function isQuiescing(accountRef) {
    const state = getState(accountRef);
    return Boolean(state && state.quiescing);
  }

  function canReconcileBeforeSpawn(lease) {
    const state = lease && getState(lease.accountRef);
    const record = getRecord(lease);
    if (!state || !record || record.phase !== 'pending' || state.quiescing) return false;
    for (const candidate of state.writers.values()) {
      if (candidate === record) continue;
      if (candidate.phase === 'pending' && candidate.lease.generation < lease.generation) {
        return false;
      }
      if (candidate.phase === 'live' && candidate.writer && isWriterAlive(candidate.writer)) {
        return false;
      }
    }
    return true;
  }

  function quiesce(accountRef, options = {}) {
    const state = getState(accountRef, true);
    if (!state) return Promise.resolve(true);
    if (state.quiescing) return state.quiescing.promise;

    const record = getRecord(options.lease);
    const writer = options.writer || (record && record.writer);
    if (!writer || !isWriterAlive(writer)) {
      cleanState(state);
      return Promise.resolve(true);
    }

    const quiescing = {
      lease: options.lease || null,
      writer,
      reason: String(options.reason || 'unspecified'),
      promise: null
    };
    state.quiescing = quiescing;
    quiescing.promise = (async () => {
      try {
        terminateWriter(writer, quiescing.reason);
      } catch (_error) {
        // kill 失败时继续保持 quiescing；只有 PID 真正退出才允许后继 cold spawn。
      }
      while (isWriterAlive(writer)) {
        await waitForPoll(pollIntervalMs);
      }
      if (state.quiescing === quiescing) {
        state.quiescing = null;
      }
      cleanState(state);
      return true;
    })();
    return quiescing.promise;
  }

  return {
    reserve,
    activate,
    release,
    hasWriter,
    isQuiescing,
    canReconcileBeforeSpawn,
    quiesce
  };
}

module.exports = {
  createWriterLifecycleCoordinator
};
