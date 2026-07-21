'use strict';

const METHOD_PROBE_THREAD_ID = '00000000-0000-4000-8000-000000000000';
const LIST_PAGE_SIZE = 100;

function createCodexNativeLifecycleStrategy(options = {}) {
  const runtimeResolver = options.runtimeResolver;
  const clientFactory = options.clientFactory;
  if (!runtimeResolver || typeof runtimeResolver.resolve !== 'function') {
    throw new TypeError('Codex lifecycle runtimeResolver is required');
  }
  if (typeof clientFactory !== 'function') {
    throw new TypeError('Codex lifecycle clientFactory is required');
  }

  let clientEntry = null;
  let capabilityEntry = null;
  let capabilityProbe = null;

  async function resolveClient() {
    const runtime = await runtimeResolver.resolve('codex', { runtimeScope: 'session-lifecycle' });
    const fingerprint = String(runtime && runtime.fingerprint || runtime && runtime.executablePath || '').trim();
    if (clientEntry && clientEntry.fingerprint === fingerprint) return clientEntry;
    closeClient(clientEntry && clientEntry.client);
    const client = await clientFactory(runtime);
    clientEntry = { client, fingerprint, runtime };
    capabilityEntry = null;
    capabilityProbe = null;
    return clientEntry;
  }

  async function capabilities() {
    const entry = await resolveClient();
    if (capabilityEntry && capabilityEntry.fingerprint === entry.fingerprint) return capabilityEntry.value;
    if (capabilityProbe) return capabilityProbe;
    capabilityProbe = probeCapabilities(entry.client).then((value) => {
      capabilityEntry = { fingerprint: entry.fingerprint, value };
      capabilityProbe = null;
      return value;
    }, (error) => {
      capabilityProbe = null;
      throw error;
    });
    return capabilityProbe;
  }

  async function listArchived() {
    const entry = await resolveClient();
    const result = [];
    const seenCursors = new Set();
    let cursor = null;
    do {
      const page = await entry.client.request('thread/list', {
        archived: true,
        cursor,
        limit: LIST_PAGE_SIZE,
        modelProviders: [],
        sourceKinds: [],
        useStateDbOnly: false
      });
      const data = Array.isArray(page && page.data) ? page.data : [];
      result.push(...data.map(mapArchivedThread).filter(Boolean));
      const nextCursor = String(page && page.nextCursor || '').trim();
      if (!nextCursor) break;
      if (seenCursors.has(nextCursor)) {
        const error = new Error('Codex archived thread cursor repeated');
        error.code = 'session_lifecycle_cursor_repeated';
        throw error;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
    return result;
  }

  return {
    provider: 'codex',
    capabilities,
    async archive(input = {}) {
      const entry = await resolveClient();
      await entry.client.request('thread/archive', { threadId: String(input.sessionId || '').trim() });
      return { archived: true };
    },
    listArchived,
    async unarchive(input = {}) {
      const entry = await resolveClient();
      await entry.client.request('thread/unarchive', { threadId: String(input.sessionId || '').trim() });
      return { unarchived: true };
    },
    close() {
      closeClient(clientEntry && clientEntry.client);
      clientEntry = null;
      capabilityEntry = null;
      capabilityProbe = null;
    }
  };
}

async function probeCapabilities(client) {
  const listArchived = await methodAvailable(() => client.request('thread/list', {
    archived: true,
    cursor: null,
    limit: 1,
    modelProviders: [],
    sourceKinds: [],
    useStateDbOnly: true
  }));
  const archive = await methodAvailable(() => client.request('thread/archive', {
    threadId: METHOD_PROBE_THREAD_ID
  }));
  const unarchive = await methodAvailable(() => client.request('thread/unarchive', {
    threadId: METHOD_PROBE_THREAD_ID
  }));
  const workflowAvailable = archive && listArchived && unarchive;
  return Object.freeze({
    provider: 'codex',
    workflowAvailable,
    operations: Object.freeze({
      archive: operation(archive),
      listArchived: operation(listArchived),
      unarchive: operation(unarchive)
    }),
    ...(!workflowAvailable ? { reason: 'native_archive_workflow_incomplete' } : {})
  });
}

async function methodAvailable(invoke) {
  try {
    await invoke();
    return true;
  } catch (error) {
    const rpcCode = Number(error && error.rpcCode);
    if (!Number.isFinite(rpcCode)) throw error;
    return rpcCode !== -32601;
  }
}

function operation(available) {
  return Object.freeze({
    support: available ? 'native' : 'unsupported',
    available: available === true,
    ...(!available ? { reason: 'native_method_unavailable' } : {})
  });
}

function mapArchivedThread(thread) {
  const id = String(thread && thread.id || '').trim();
  if (!id) return null;
  const name = String(thread && thread.name || '').trim();
  const preview = String(thread && thread.preview || '').trim();
  const projectPath = String(thread && thread.cwd || '').trim();
  const updatedAtSeconds = Number(thread && thread.updatedAt);
  return {
    id,
    title: name || preview || '未命名会话',
    provider: 'codex',
    ...(projectPath ? { projectPath } : {}),
    origin: 'native',
    canUnarchive: true,
    updatedAt: Number.isFinite(updatedAtSeconds) ? updatedAtSeconds * 1000 : 0
  };
}

function closeClient(client) {
  if (!client) return;
  if (typeof client.close === 'function') client.close();
  else if (typeof client.destroy === 'function') client.destroy();
}

module.exports = {
  createCodexNativeLifecycleStrategy
};
