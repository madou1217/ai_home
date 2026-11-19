export type ViewerIdentityTuple = readonly [id: string, sessionKey: string, serverId: string];

export interface TabIncarnation {
  tuple: ViewerIdentityTuple;
  serverGeneration: number;
  incarnation: number;
  invalidated: boolean;
}

export interface CloseTarget {
  id: string;
  closeToken?: string;
}

export interface ParsedCloseToken {
  serverGeneration: number;
  incarnation: number;
}

export function formatCloseToken(serverGeneration: number, incarnation: number): string {
  return `${serverGeneration}:${incarnation}`;
}

export function parseCloseToken(token?: string): ParsedCloseToken | null {
  if (!token) return null;
  const parts = token.split(':');
  if (parts.length !== 2) return null;
  const serverGeneration = Number(parts[0]);
  const incarnation = Number(parts[1]);
  if (!Number.isInteger(serverGeneration) || serverGeneration <= 0) return null;
  if (!Number.isInteger(incarnation) || incarnation <= 0) return null;
  return { serverGeneration, incarnation };
}

interface ViewerAuthorityOptions {
  readLiveServerId: () => string;
  isPoweredOn: (serverId: string, sessionKey: string) => boolean;
}

interface ViewerAuthorityState {
  serverGeneration: number;
  incarnationSeq: number;
  liveServerId: string;
  serverAdmitted: boolean;
  serverId: string;
  incarnationsById: Map<string, TabIncarnation>;
}

/**
 * Synchronous per-server + per-identity incarnation authority for the global
 * floating Web Terminal host.
 *
 * Updates synchronously on control-plane profile switches (including same-tick
 * A -> B -> A) and power-OFF transitions (including same-tick ON -> OFF -> ON)
 * so child terminal attachment fallback and pre-dispose close authorization
 * never rely on a lagging React render snapshot.
 */
export function createWebTerminalViewerAuthority({
  readLiveServerId,
  isPoweredOn,
}: ViewerAuthorityOptions) {
  const state: ViewerAuthorityState = {
    serverGeneration: 0,
    incarnationSeq: 0,
    liveServerId: readLiveServerId(),
    serverAdmitted: false,
    serverId: '',
    incarnationsById: new Map(),
  };

  const invalidateAll = () => {
    for (const entry of state.incarnationsById.values()) {
      entry.invalidated = true;
    }
  };

  const syncLiveServer = () => {
    const nextLiveServerId = readLiveServerId();
    if (state.liveServerId !== nextLiveServerId) {
      state.liveServerId = nextLiveServerId;
      state.serverGeneration += 1;
      invalidateAll();
    }
    return nextLiveServerId;
  };

  const onServerProfileChanged = () => {
    syncLiveServer();
  };

  const onPowerPreferencesChanged = () => {
    if (!state.serverAdmitted || !state.serverId) return;
    for (const entry of state.incarnationsById.values()) {
      if (entry.invalidated) continue;
      const [, sessionKey, sid] = entry.tuple;
      if (sid !== state.serverId || !isPoweredOn(sid, sessionKey)) {
        entry.invalidated = true;
      }
    }
  };

  const reconcile = (
    serverAdmitted: boolean,
    admittedServerId: string,
    exactTuples: ReadonlyArray<ViewerIdentityTuple>,
  ) => {
    syncLiveServer();
    if (state.serverAdmitted !== serverAdmitted || state.serverId !== admittedServerId) {
      state.serverGeneration += 1;
      state.serverAdmitted = serverAdmitted;
      state.serverId = admittedServerId;
      invalidateAll();
      state.incarnationsById = new Map();
    }

    const currentServerGeneration = state.serverGeneration;
    const nextIncarnations = new Map<string, TabIncarnation>();
    if (serverAdmitted) {
      for (const tuple of exactTuples) {
        const [id, sessionKey, sid] = tuple;
        const prev = state.incarnationsById.get(id);
        if (
          prev
          && !prev.invalidated
          && prev.serverGeneration === currentServerGeneration
          && prev.tuple[0] === id
          && prev.tuple[1] === sessionKey
          && prev.tuple[2] === sid
        ) {
          nextIncarnations.set(id, prev);
        } else {
          state.incarnationSeq += 1;
          nextIncarnations.set(id, {
            tuple,
            serverGeneration: currentServerGeneration,
            incarnation: state.incarnationSeq,
            invalidated: false,
          });
        }
      }
    }
    for (const [id, prev] of state.incarnationsById) {
      if (nextIncarnations.get(id) !== prev) {
        prev.invalidated = true;
      }
    }
    state.incarnationsById = nextIncarnations;

    const incarnationSignature = JSON.stringify(
      Array.from(
        nextIncarnations.values(),
        (entry) => [entry.tuple[0], formatCloseToken(entry.serverGeneration, entry.incarnation)] as const,
      ),
    );

    return {
      serverGeneration: currentServerGeneration,
      incarnationSignature,
    };
  };

  const resolveValidatedEntry = (
    id: string,
    closeToken?: string,
    requiredServerId?: string,
  ): TabIncarnation | null => {
    const parsed = parseCloseToken(closeToken);
    if (!parsed) return null;
    const liveSid = syncLiveServer();
    if (!state.serverAdmitted || !state.serverId || liveSid !== state.serverId) return null;
    if (requiredServerId !== undefined && (!requiredServerId || state.serverId !== requiredServerId)) {
      return null;
    }
    if (state.serverGeneration !== parsed.serverGeneration) return null;
    const entry = state.incarnationsById.get(id);
    if (
      !entry
      || entry.invalidated
      || entry.serverGeneration !== parsed.serverGeneration
      || entry.incarnation !== parsed.incarnation
    ) {
      return null;
    }
    const [entryId, sessionKey, entrySid] = entry.tuple;
    if (!entryId || entryId !== id || !sessionKey || entrySid !== state.serverId) {
      return null;
    }
    if (!isPoweredOn(state.serverId, sessionKey)) {
      entry.invalidated = true;
      return null;
    }
    return entry;
  };

  const isSessionCurrent = (id: string, closeToken?: string): boolean => (
    resolveValidatedEntry(id, closeToken) !== null
  );

  const isMotionScopeCurrent = (
    originServerId: string,
    originServerGeneration: number,
  ): boolean => {
    const liveSid = syncLiveServer();
    return Boolean(
      originServerId
      && state.serverAdmitted
      && state.serverId === originServerId
      && liveSid === originServerId
      && state.serverGeneration === originServerGeneration,
    );
  };

  const consumeIncarnationForClose = (
    admittedServerId: string,
    expectedServerId: string,
    expectedServerGeneration: number,
    expectedIncarnation: number,
    tuple: ViewerIdentityTuple,
  ): boolean => {
    if (!admittedServerId || admittedServerId !== expectedServerId) return false;
    const [id, sessionKey, tupleSid] = tuple;
    if (!id || !sessionKey || tupleSid !== expectedServerId) return false;
    const entry = resolveValidatedEntry(
      id,
      formatCloseToken(expectedServerGeneration, expectedIncarnation),
      expectedServerId,
    );
    if (
      !entry
      || entry.tuple[0] !== id
      || entry.tuple[1] !== sessionKey
      || entry.tuple[2] !== expectedServerId
    ) {
      return false;
    }
    entry.invalidated = true;
    return true;
  };

  const consumeTokenForClose = (
    admittedServerId: string,
    id: string,
    closeToken?: string,
  ): boolean => {
    const entry = resolveValidatedEntry(id, closeToken, admittedServerId);
    if (!entry) return false;
    entry.invalidated = true;
    return true;
  };

  const snapshotLiveIncarnations = (
    originServerId: string,
    originServerGeneration: number,
  ): TabIncarnation[] => {
    if (!isMotionScopeCurrent(originServerId, originServerGeneration)) return [];
    return Array.from(state.incarnationsById.values()).filter((entry) => !entry.invalidated);
  };

  return {
    onServerProfileChanged,
    onPowerPreferencesChanged,
    reconcile,
    isSessionCurrent,
    isMotionScopeCurrent,
    consumeIncarnationForClose,
    consumeTokenForClose,
    snapshotLiveIncarnations,
  };
}
