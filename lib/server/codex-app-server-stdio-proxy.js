'use strict';

const { spawn } = require('node:child_process');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { withHiddenWindowsConsole } = require('../runtime/hidden-child-process-options');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { resolvePlatformPath, resolveRootPath } = require('../runtime/platform-path');
const { repairCodexSessionVisibility } = require('../cli/services/ai-cli/codex-session-visibility-repair');
const { startCodexCliResumeCwdProxy } = require('./codex-cli-resume-proxy');
const {
  buildCodexDefaultCliEnv,
  runCodexDefaultCli
} = require('./codex-default-cli-launcher');
const { rewriteCodexAppServerClientMessage } = require('./codex-app-server-proxy');
const { postJson } = require('./provider-session-hook-sender');
const {
  rememberThreadResumeRequest,
  patchThreadResumeResponseMessage
} = require('./codex-thread-resume-response-patch');
const {
  readCodexSessionNotificationsSince,
  resolveCodexSessionNotificationQueuePath
} = require('./codex-session-notification-queue');
const { readServerConfig } = require('./server-config-store');
const { buildServerBaseUrl, DEFAULT_SERVER_API_KEY } = require('./server-defaults');
const { readDefaultAccountRef } = require('../account/default-account-store');
const { mergeConfigs } = require('../cli/services/pty/codex-config-sync');
const { appendBoundedJsonLine } = require('./bounded-log-writer');
const {
  patchCodexThreadTurnModelsResponse,
  readCodexTurnModelContext
} = require('./codex-turn-model-metadata');
const { resolveHostHomeDir } = require('../runtime/host-home');
const {
  decodeEncodedWindowsPath,
  normalizeWindowsPathForCodexConfig
} = require('../runtime/windows-path-encoding');
const {
  CODEX_INTERACTIVE_SOURCE_KINDS,
  isCodexSubagentThread,
  isCodexWorktreeProjectPath,
  resolveCodexThreadListSourceKinds
} = require('../sessions/codex-visible-session-policy');
const {
  listCodexStateDbPaths,
  listCodexTopLevelStateDbPaths
} = require('../sessions/codex-state-db-discovery');
const {
  CODEX_DESKTOP_AUTH_TYPES,
  buildCodexDesktopRuntimeAuth,
  resolveAiHomeDir,
  resolveCodexDesktopAccountIdentity,
  resolveCodexDesktopChatGptAccount,
  resolveCodexDesktopChatGptIdentity
} = require('./codex-desktop-account');
const { resolveCodexDesktopRuntimeDir } = require('../runtime/aih-storage-layout');
const { AGGREGATE_THREAD_LIST_MAX_PAGES, AGGREGATE_THREAD_LIST_MAX_ITEMS, STATE_THREAD_LIST_CURSOR_PREFIX, TRACE_THREAD_LIST_SUMMARY_ITEMS, FAST_THREAD_READ_MIN_BYTES, FAST_THREAD_READ_TURN_LIMIT, FAST_THREAD_READ_INITIAL_BYTES, FAST_THREAD_READ_MAX_BYTES, FAST_THREAD_READ_MAX_COMMAND_OUTPUT_CHARS, STALE_IN_PROGRESS_TURN_AFTER_MS, REMOTE_HYDRATION_SUPPRESSION_TTL_MS, SESSION_NOTIFICATION_POLL_INTERVAL_MS, SESSION_NOTIFICATION_DEBOUNCE_MS, DESKTOP_ACCOUNT_SYNC_INTERVAL_MS, OPTIMIZED_ROLLOUT_REPAIR_INTERVAL_MS, MISSING_THREAD_TITLE_REPAIR_INTERVAL_MS, THREAD_TITLE_REPAIR_LIMIT, THREAD_TITLE_REPAIR_MAX_BYTES, PENDING_ACTIVE_TURN_ID, REMOTE_TRACE_METHODS, REMOTE_TRACE_STDERR_PATTERNS, HYDRATION_NOTIFICATION_METHODS, LIVE_THREAD_TURN_METHODS, DatabaseSyncCtor, didResolveDatabaseSync, readHookState, createLinePump, tryParseJson, sanitizeTraceText, getDatabaseSyncCtor, readCurrentCodexConfig, hasCodexRuntimeConfig, resolveHostCodexHome, readCurrentCodexRuntimeConfig, isAihManagedProvider, writeJsonFilePrivate, getSqliteTableColumns, readCodexSpawnedChildIdsFromDb, readCodexHiddenThreadIds, getThreadRequestId, resolveCodexHome, resolveCodexStateHome, isAihRolloutSidecarPath, deriveOriginalRolloutPathFromSidecar, isExistingCanonicalRolloutFile, findCanonicalRolloutPathByThreadId, resolveCanonicalRolloutPath, isSyntheticThreadTitle, extractObjectiveTitleFromText, extractThreadTitleFromUserText, sanitizeThreadTitleForRepair, extractThreadTitleFromCodexPayload, extractThreadTitleFromRolloutLine, readThreadTitleFromSessionIndex, readThreadTitleFromRolloutFile, repairThreadRolloutPathIfNeeded, getThreadStateRow, findThreadStateRow, normalizeThreadListSourceKinds, addSqlInFilter, buildThreadListStateQuery, readThreadListFromStateDb, getStateThreadTimestamp, countStateThreadFields, compareStateThreadCandidates, normalizeStateThreadSortKey, buildStateThreadFilterSignature, encodeStateThreadCursor, decodeStateThreadCursor, compareStateThreadRows, readStateThreadListPage, timestampToSeconds, normalizeSessionSource, resolveThreadDisplayTitle, buildThreadFromStateRow } = require('./codex-app-server-stdio-proxy-utils');
const { createTraceWriter, summarizeJsonRpcForTrace, summarizeThreadListTraceItem, isRemoteTracePayload, traceRemoteJsonRpc, isRemoteTraceStderrLine } = require('./codex-app-server-stdio-proxy-trace');
const { escapeTomlString, upsertTomlStringValue, ensureDirectory, buildCodexAppServerRuntimeConfig, prepareCodexAppServerRuntimeHome, buildCodexAppServerSpawnEnv } = require('./codex-app-server-stdio-proxy-runtime');
const { buildCodexDesktopAccountLoginRequest, createCodexDesktopAccountSyncController } = require('./codex-app-server-stdio-proxy-desktop');
const { buildStateThreadListResponse, buildThreadListStateThreads } = require('./codex-app-server-stdio-proxy-state');
const { shouldRepairThreadTitleValue, buildMissingThreadTitleSelect, repairMissingThreadTitleFields } = require('./codex-app-server-stdio-proxy-title');
const { restoreOptimizedRolloutPathInStateDbs, repairMissingOptimizedRolloutPaths } = require('./codex-app-server-stdio-proxy-rollout');
const { writeRemoteHydrationSuppressionState, reconcileSelectedThreadConfig, reconcileResumeThreadProvider, rewriteThreadResumeRuntimeConfig, buildFastResumeHydrationRequest, shouldHydrateLiveThreadTurnPayload, buildTurnLiveThreadHydrationRequest, buildTurnStartHydrationRequest, getHydrationNotificationThreadId, shouldSuppressHydrationNotification, getLiveThreadIdFromMessage, getClosedThreadIdFromMessage, getThreadIdleStatusIdFromMessage, getTurnLifecycleFromMessage, buildCodexAppServerSessionEvent, createCodexAppServerSessionEventPublisher, buildCodexThreadStatusNotification, createCodexSessionNotificationPoller, rewriteStaleTurnSteerAsStart } = require('./codex-app-server-stdio-proxy-resume');
const { durationToMs, truncateText, normalizeCommandSource, normalizeCommandStatus, normalizeApprovalMode, normalizeSandboxPolicy, createEmptyTurn, normalizeStaleInProgressTurns, parseRecentCodexRolloutTurns, readRecentRolloutTurns, buildFastThreadReadResponse } = require('./codex-app-server-stdio-proxy-fastread');
const { patchThreadListVisibilityResponse, mergeThreadListData, patchThreadConfigResponse, patchAccountReadResponse, patchAuthStatusResponse, getThreadObjectId, resolveThreadTitleForPatch, patchThreadObjectTitleFields, patchThreadTitleFieldsResponse, normalizeThreadGoalStatus, timestampMsToSeconds, normalizeNullableInteger, readThreadGoalFromGoalDb, patchThreadGoalGetResponse } = require('./codex-app-server-stdio-proxy-patch');
const { shouldAggregateThreadList, normalizeThreadSourceKind, isInteractiveThreadSourceKinds, rewriteThreadListVisibleSources, buildAggregatePageRequest } = require('./codex-app-server-stdio-proxy-aggregate');
const { parseProxyArgs, waitForReadyFile, startRemoteControlProxyProcess, hasArg, runCodexResumeVisibilityRepair, cleanupTemporaryFiles, forwardExitCode, hasExplicitRemoteArg, normalizeRemoteHost, canConnectToTcpEndpoint, resolveCliResumeRemoteConfig, buildCodexCliResumeArgs, runCodexCliResume } = require('./codex-app-server-stdio-proxy-cliresume');
function resolveThreadModelResponseContext(payload, deps = {}) {
  if (!payload || payload.method !== 'thread/read') return null;
  const threadId = getThreadRequestId(payload);
  if (!threadId) return null;
  const found = findThreadStateRow(threadId, deps);
  const rolloutPath = String(found && found.row && found.row.rollout_path || '').trim();
  return rolloutPath ? { threadId, rolloutPath } : null;
}

function getThreadGoalRequestContext(payload) {
  if (!payload || payload.method !== 'thread/goal/get') return null;
  const threadId = getThreadRequestId(payload);
  if (!threadId) return null;
  return { threadId };
}

function getThreadListRequestContext(payload) {
  if (!payload || payload.method !== 'thread/list') return null;
  const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params)
    ? payload.params
    : {};
  return {
    cwd: String(params.cwd || '').trim(),
    archived: params.archived === true,
    sourceKinds: Array.isArray(params.sourceKinds) ? params.sourceKinds.slice() : [],
    modelProviders: Array.isArray(params.modelProviders) ? params.modelProviders.slice() : [],
    limit: Number(params.limit),
    cursor: Object.prototype.hasOwnProperty.call(params, 'cursor') && params.cursor !== null
      ? String(params.cursor || '')
      : null,
    sortKey: String(params.sortKey || '').trim(),
    useStateDbOnly: params.useStateDbOnly === true
  };
}

function runCodexAppServerStdioProxy(argv, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const spawnImpl = deps.spawn || spawn;
  const processObj = deps.processObj || process;
  const parsed = parseProxyArgs(argv);
  if (parsed.runCliDefault) {
    return runCodexDefaultCli(parsed.upstream, parsed.forwardArgs, {
      ...deps,
      fs,
      spawn: spawnImpl,
      processObj
    });
  }
  if (parsed.runCliResume) {
    return runCodexCliResume(argv, { ...deps, fs, spawn: spawnImpl, processObj });
  }
  if (parsed.repairResumeVisibility) {
    return runCodexResumeVisibilityRepair(argv, { ...deps, fs, processObj });
  }
  if (!parsed.upstream) {
    throw new Error('missing_upstream_binary');
  }

  let state = readHookState(fs, parsed.stateFile);
  const writeTrace = createTraceWriter(fs, state);
  const aggregateContexts = new Map();
  const aggregateRequestIdToContextId = new Map();
  const responsePatchContexts = new Map();
  const threadModelResponseContexts = new Map();
  const accountReadResponseIds = new Set();
  const authStatusResponseContexts = new Map();
  const threadListResponseContexts = new Map();
  const threadGoalGetResponseContexts = new Map();
  const threadResumeResponseContexts = new Map();
  const suppressedResponseIds = new Set();
  const hydrationResponseIdToThreadId = new Map();
  const pendingHydrationsByThreadId = new Map();
  const liveThreadIds = new Set();
  const activeTurnIdsByThreadId = new Map();
  let sessionNotificationPoller = null;
  let hydrationRequestSeq = 0;
  let lastOptimizedRolloutRepairAtMs = 0;
  let lastMissingThreadTitleRepairAtMs = 0;
  if (!state.enabled) {
    const child = spawnImpl(parsed.upstream, parsed.forwardArgs, {
      stdio: 'inherit',
      env: processObj.env || process.env
    });
    forwardExitCode(child, processObj);
    return child;
  }

  const remoteControlProxy = startRemoteControlProxyProcess(fs, state, writeTrace, {
    ...deps,
    processObj
  });

  const spawnEnvResult = buildCodexAppServerSpawnEnv(fs, state, {
    ...deps,
    processObj,
    chatgptBaseUrl: remoteControlProxy && remoteControlProxy.baseUrl
  });
  if (spawnEnvResult.runtime) {
    writeTrace({
      direction: 'proxy_internal',
      action: 'prepare_desktop_runtime_home',
      runtimeHome: spawnEnvResult.runtime.runtimeHome,
      hostCodexHome: spawnEnvResult.runtime.hostCodexHome,
      accountRef: spawnEnvResult.runtime.accountRef,
      authType: spawnEnvResult.runtime.authType || ''
    });
  }

  const child = spawnImpl(parsed.upstream, parsed.forwardArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: spawnEnvResult.env
  });
  const desktopAccountSync = createCodexDesktopAccountSyncController({
    ...deps,
    fs,
    processObj,
    stateFile: parsed.stateFile,
    initialAccountRef: spawnEnvResult.runtime && spawnEnvResult.runtime.identityAccountRef,
    writeTrace,
    writeUpstream: (payload) => child.stdin.write(payload),
    onState: (nextState) => {
      state = nextState;
    }
  });
  const setIntervalImpl = deps.setInterval || setInterval;
  const clearIntervalImpl = deps.clearInterval || clearInterval;
  const desktopAccountSyncEnabled = deps.enableDesktopAccountSync === true || processObj === process;
  const desktopAccountSyncTimer = parsed.stateFile && desktopAccountSyncEnabled
    ? setIntervalImpl(() => desktopAccountSync.refresh(), DESKTOP_ACCOUNT_SYNC_INTERVAL_MS)
    : null;
  if (desktopAccountSyncTimer && typeof desktopAccountSyncTimer.unref === 'function') {
    desktopAccountSyncTimer.unref();
  }
  if (remoteControlProxy && remoteControlProxy.child) {
    child.on('exit', () => {
      try { remoteControlProxy.child.kill('SIGTERM'); } catch (_error) {}
      cleanupTemporaryFiles(fs, [remoteControlProxy.suppressStateFile]);
    });
  }

  child.on('exit', () => {
    pendingHydrationsByThreadId.clear();
    if (desktopAccountSyncTimer) clearIntervalImpl(desktopAccountSyncTimer);
  });

  const repairMissingOptimizedRolloutPathsForList = (payload) => {
    if (!payload || payload.method !== 'thread/list') return;
    const nowMs = Date.now();
    if (nowMs - lastOptimizedRolloutRepairAtMs >= OPTIMIZED_ROLLOUT_REPAIR_INTERVAL_MS) {
      lastOptimizedRolloutRepairAtMs = nowMs;
      const result = repairMissingOptimizedRolloutPaths({
        fs,
        processObj,
        DatabaseSync: deps.DatabaseSync
      });
      if (result.repaired > 0 || result.failed > 0) {
        writeTrace({
          direction: 'proxy_internal',
          action: 'repair_missing_optimized_rollout_paths',
          checked: result.checked,
          repaired: result.repaired,
          failed: result.failed,
          threadIds: result.items.map((item) => item.threadId).filter(Boolean)
        });
      }
    }
    if (nowMs - lastMissingThreadTitleRepairAtMs < MISSING_THREAD_TITLE_REPAIR_INTERVAL_MS) return;
    lastMissingThreadTitleRepairAtMs = nowMs;
    const titleResult = repairMissingThreadTitleFields({
      fs,
      processObj,
      DatabaseSync: deps.DatabaseSync
    });
    if (titleResult.repaired > 0 || titleResult.failed > 0) {
      writeTrace({
        direction: 'proxy_internal',
        action: 'repair_missing_thread_title_fields',
        checked: titleResult.checked,
        repaired: titleResult.repaired,
        failed: titleResult.failed,
        threadIds: titleResult.items.map((item) => item.threadId).filter(Boolean)
      });
    }
  };

  const startHiddenHydration = (hydrationRequest, hydrationThreadId, pendingPayloads, action) => {
    if (!hydrationRequest || !hydrationThreadId) return false;
    const existing = pendingHydrationsByThreadId.get(hydrationThreadId);
    if (existing) {
      for (const payload of pendingPayloads || []) {
        existing.pendingPayloads.push(payload);
      }
      existing.remoteSuppressExpiresAtMs = Date.now() + REMOTE_HYDRATION_SUPPRESSION_TTL_MS;
      writeRemoteHydrationSuppressionState(
        fs,
        remoteControlProxy && remoteControlProxy.suppressStateFile,
        pendingHydrationsByThreadId
      );
      return true;
    }
    const hydrationResponseId = String(hydrationRequest.id);
    const remoteSuppressExpiresAtMs = Date.now() + REMOTE_HYDRATION_SUPPRESSION_TTL_MS;
    suppressedResponseIds.add(hydrationResponseId);
    hydrationResponseIdToThreadId.set(hydrationResponseId, hydrationThreadId);
    pendingHydrationsByThreadId.set(hydrationThreadId, {
      responseId: hydrationResponseId,
      pendingPayloads: [...(pendingPayloads || [])],
      remoteSuppressExpiresAtMs
    });
    writeRemoteHydrationSuppressionState(
      fs,
      remoteControlProxy && remoteControlProxy.suppressStateFile,
      pendingHydrationsByThreadId
    );
    const hydrationPayload = JSON.stringify(hydrationRequest);
    writeTrace({
      direction: 'proxy_to_upstream',
      action,
      threadId: hydrationThreadId,
      rewritten: hydrationPayload
    });
    child.stdin.write(`${hydrationPayload}\n`);
    return true;
  };

  const markTurnStartPending = (payload) => {
    if (!payload || payload.method !== 'turn/start') return;
    const threadId = getThreadRequestId(payload);
    if (threadId) activeTurnIdsByThreadId.set(threadId, PENDING_ACTIVE_TURN_ID);
  };

  const writeCodexSessionNotification = (payload) => {
    if (!payload || typeof payload !== 'object') return;
    processObj.stdout.write(`${JSON.stringify(payload)}\n`);
  };
  const publishCodexAppServerSessionEvent = createCodexAppServerSessionEventPublisher({
    receiverUrl: state.providerHookReceiverUrl,
    postSessionEvent: deps.postSessionEvent,
    timeoutMs: deps.sessionEventPostTimeoutMs,
    writeTrace,
    nowMs: typeof deps.nowMs === 'function' ? deps.nowMs : undefined
  });

  const trackTurnLifecycleMessage = (payload) => {
    publishCodexAppServerSessionEvent(payload);
    const closedThreadId = getClosedThreadIdFromMessage(payload);
    if (closedThreadId) {
      liveThreadIds.delete(closedThreadId);
      activeTurnIdsByThreadId.delete(closedThreadId);
    }
    const liveThreadId = getLiveThreadIdFromMessage(payload);
    if (liveThreadId) liveThreadIds.add(liveThreadId);
    const idleThreadId = getThreadIdleStatusIdFromMessage(payload);
    if (idleThreadId) activeTurnIdsByThreadId.delete(idleThreadId);
    const lifecycle = getTurnLifecycleFromMessage(payload);
    if (!lifecycle) return;
    if (lifecycle.type === 'started') {
      activeTurnIdsByThreadId.set(lifecycle.threadId, lifecycle.turnId || PENDING_ACTIVE_TURN_ID);
      return;
    }
    const currentTurnId = String(activeTurnIdsByThreadId.get(lifecycle.threadId) || '').trim();
    if (
      !currentTurnId
      || !lifecycle.turnId
      || currentTurnId === lifecycle.turnId
      || currentTurnId === PENDING_ACTIVE_TURN_ID
    ) {
      activeTurnIdsByThreadId.delete(lifecycle.threadId);
    }
  };

  const queueFile = state.sessionNotificationQueueFile
    || resolveCodexSessionNotificationQueuePath(resolveAiHomeDir({ processObj, os: deps.os }));
  sessionNotificationPoller = createCodexSessionNotificationPoller({
    fs,
    queueFile,
    liveThreadIds,
    writeTrace,
    writeNotification: writeCodexSessionNotification,
    pollIntervalMs: deps.sessionNotificationPollIntervalMs,
    debounceMs: deps.sessionNotificationDebounceMs
  });

  const stdinPump = createLinePump((line) => {
    const rewrittenPayload = rewriteCodexAppServerClientMessage(line);
    let parsedPayload = tryParseJson(rewrittenPayload);
    const threadConfigReconcile = reconcileSelectedThreadConfig(parsedPayload, {
      fs,
      processObj,
      DatabaseSync: deps.DatabaseSync
    });
    if (threadConfigReconcile && threadConfigReconcile.changed) {
      writeTrace({
        direction: 'proxy_internal',
        action: 'resolve_selected_thread_runtime_config',
        ...threadConfigReconcile
      });
    }
    parsedPayload = rewriteThreadResumeRuntimeConfig(parsedPayload, threadConfigReconcile);
    const staleSteerRewrite = rewriteStaleTurnSteerAsStart(parsedPayload, activeTurnIdsByThreadId);
    if (staleSteerRewrite && staleSteerRewrite.changed) {
      writeTrace({
        direction: 'proxy_internal',
        action: 'rewrite_stale_turn_steer_as_start',
        threadId: staleSteerRewrite.threadId,
        expectedTurnId: staleSteerRewrite.expectedTurnId
      });
      parsedPayload = staleSteerRewrite.payload;
    }
    parsedPayload = rewriteThreadListVisibleSources(parsedPayload);
    const finalClientPayload = parsedPayload ? JSON.stringify(parsedPayload) : rewrittenPayload;
    if (
      parsedPayload
      && parsedPayload.method === 'account/read'
      && Object.prototype.hasOwnProperty.call(parsedPayload, 'id')
    ) {
      accountReadResponseIds.add(String(parsedPayload.id));
    }
    if (
      parsedPayload
      && parsedPayload.method === 'getAuthStatus'
      && Object.prototype.hasOwnProperty.call(parsedPayload, 'id')
    ) {
      const params = parsedPayload.params && typeof parsedPayload.params === 'object'
        ? parsedPayload.params
        : {};
      authStatusResponseContexts.set(String(parsedPayload.id), {
        includeToken: params.includeToken !== false,
        refreshToken: params.refreshToken === true
      });
    }
    if (
      parsedPayload
      && parsedPayload.method === 'thread/goal/get'
      && Object.prototype.hasOwnProperty.call(parsedPayload, 'id')
    ) {
      const context = getThreadGoalRequestContext(parsedPayload);
      if (context) threadGoalGetResponseContexts.set(String(parsedPayload.id), context);
    }
    if (
      parsedPayload
      && parsedPayload.method === 'thread/list'
      && Object.prototype.hasOwnProperty.call(parsedPayload, 'id')
    ) {
      const context = getThreadListRequestContext(parsedPayload);
      if (context) threadListResponseContexts.set(String(parsedPayload.id), context);
    }
    rememberThreadResumeRequest(parsedPayload, threadResumeResponseContexts);
    if (threadConfigReconcile && Object.prototype.hasOwnProperty.call(parsedPayload || {}, 'id')) {
      responsePatchContexts.set(String(parsedPayload.id), {
        modelProvider: threadConfigReconcile.currentProvider,
        model: threadConfigReconcile.currentModel
      });
    }
    const fastThreadResponse = buildFastThreadReadResponse(parsedPayload, {
      fs,
      processObj,
      DatabaseSync: deps.DatabaseSync,
      fastReadMinBytes: deps.fastReadMinBytes,
      fastReadTurnLimit: deps.fastReadTurnLimit,
      fastReadInitialBytes: deps.fastReadInitialBytes,
      fastReadMaxBytes: deps.fastReadMaxBytes,
      fastReadMaxCommandOutputChars: deps.fastReadMaxCommandOutputChars,
      staleInProgressAfterMs: deps.staleInProgressAfterMs,
      nowMs: deps.nowMs,
      activeTurnIdsByThreadId
    });
    if (fastThreadResponse) {
      if (Object.prototype.hasOwnProperty.call(parsedPayload || {}, 'id')) {
        responsePatchContexts.delete(String(parsedPayload.id));
      }
      if (parsedPayload && parsedPayload.method === 'thread/resume') {
        const hydrationRequest = buildFastResumeHydrationRequest(
          parsedPayload,
          threadConfigReconcile,
          hydrationRequestSeq += 1
        );
        if (hydrationRequest) {
          const hydrationThreadId = getThreadRequestId(hydrationRequest);
          startHiddenHydration(
            hydrationRequest,
            hydrationThreadId,
            [],
            'hydrate_fast_thread_resume'
          );
        }
      }
      const responsePayload = JSON.stringify({
        id: fastThreadResponse.id,
        result: fastThreadResponse.result
      });
      writeTrace({
        direction: 'proxy_internal',
        action: `fast_${parsedPayload.method.replace('/', '_')}`,
        ...fastThreadResponse.meta
      });
      const fastThreadId = String(fastThreadResponse.meta && fastThreadResponse.meta.threadId || '').trim();
      if (fastThreadId) liveThreadIds.add(fastThreadId);
      processObj.stdout.write(`${responsePayload}\n`);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(parsedPayload || {}, 'id')) {
      const modelContext = resolveThreadModelResponseContext(parsedPayload, {
        fs,
        processObj,
        DatabaseSync: deps.DatabaseSync
      });
      if (modelContext) {
        threadModelResponseContexts.set(String(parsedPayload.id), modelContext);
      }
    }
    if (shouldHydrateLiveThreadTurnPayload(parsedPayload)) {
      const turnThreadId = getThreadRequestId(parsedPayload);
      const pendingHydration = turnThreadId ? pendingHydrationsByThreadId.get(turnThreadId) : null;
      if (pendingHydration) {
        markTurnStartPending(parsedPayload);
        pendingHydration.pendingPayloads.push(finalClientPayload);
        writeTrace({
          direction: 'proxy_internal',
          action: 'queue_turn_payload_until_thread_hydrated',
          threadId: turnThreadId,
          hydrationResponseId: pendingHydration.responseId,
          method: parsedPayload.method
        });
        return;
      }
      if (turnThreadId && !liveThreadIds.has(turnThreadId)) {
        const stateRowResult = findThreadStateRow(turnThreadId, {
          fs,
          processObj,
          DatabaseSync: deps.DatabaseSync
        });
        if (stateRowResult && stateRowResult.row) {
          const hydrationBasePayload = {
            id: parsedPayload.id,
            method: 'thread/resume',
            params: { threadId: turnThreadId }
          };
          const turnHydrationReconcile = reconcileSelectedThreadConfig(hydrationBasePayload, {
            fs,
            processObj,
            DatabaseSync: deps.DatabaseSync
          });
          const hydrationRequest = buildTurnLiveThreadHydrationRequest(
            parsedPayload,
            turnHydrationReconcile,
            hydrationRequestSeq += 1
          );
          if (startHiddenHydration(
            hydrationRequest,
            turnThreadId,
            [finalClientPayload],
            `hydrate_${String(parsedPayload.method || 'turn').replace(/[^A-Za-z0-9]+/g, '_')}_missing_thread`
          )) {
            markTurnStartPending(parsedPayload);
            writeTrace({
              direction: 'proxy_internal',
              action: 'queue_turn_payload_until_thread_hydrated',
              threadId: turnThreadId,
              reason: 'thread_not_registered_in_proxy',
              method: parsedPayload.method
            });
            return;
          }
        }
      }
    }
    const stateThreadListResponse = buildStateThreadListResponse(parsedPayload, {
      fs,
      processObj,
      DatabaseSync: deps.DatabaseSync
    });
    if (stateThreadListResponse) {
      const response = JSON.stringify(stateThreadListResponse);
      if (state.traceResponses) {
        writeTrace({
          direction: 'proxy_to_client',
          payload: response,
          stateDbPage: true
        });
      }
      processObj.stdout.write(`${response}\n`);
      return;
    }
    repairMissingOptimizedRolloutPathsForList(parsedPayload);
    if (shouldAggregateThreadList(parsedPayload)) {
      const originalId = parsedPayload.id;
      const firstRequest = buildAggregatePageRequest(
        parsedPayload,
        null,
        originalId,
        AGGREGATE_THREAD_LIST_MAX_ITEMS
      );
      const contextId = String(originalId);
      aggregateContexts.set(contextId, {
        originalId,
        requestTemplate: firstRequest,
        pagesFetched: 0,
        collectedData: [],
        requestedItems: Number(firstRequest.params && firstRequest.params.limit) || 0,
        backwardsCursor: null,
        nextCursor: null
      });
      aggregateRequestIdToContextId.set(String(originalId), contextId);
      const payload = JSON.stringify(firstRequest);
      writeTrace({
        direction: 'client_to_upstream',
        original: line,
        rewritten: payload,
        changed: payload !== line,
        aggregate: true
      });
      traceRemoteJsonRpc(writeTrace, state, 'client_to_upstream', payload, {
        changed: payload !== line,
        aggregate: true
      });
      child.stdin.write(`${payload}\n`);
      return;
    }
    if (line) {
      writeTrace({
        direction: 'client_to_upstream',
        original: line,
        rewritten: finalClientPayload,
        changed: finalClientPayload !== line
      });
      traceRemoteJsonRpc(writeTrace, state, 'client_to_upstream', finalClientPayload, {
        changed: finalClientPayload !== line
      });
    }
    markTurnStartPending(parsedPayload);
    child.stdin.write(`${finalClientPayload}\n`);
  });
  const stdoutPump = createLinePump((line) => {
    const parsedResponse = tryParseJson(line);
    traceRemoteJsonRpc(writeTrace, state, 'upstream_to_client', parsedResponse || line);
    trackTurnLifecycleMessage(parsedResponse);
    const responseId = parsedResponse && Object.prototype.hasOwnProperty.call(parsedResponse, 'id')
      ? String(parsedResponse.id)
      : '';
    if (responseId && desktopAccountSync.handleResponse(parsedResponse)) {
      return;
    }
    if (!responseId && shouldSuppressHydrationNotification(parsedResponse, pendingHydrationsByThreadId)) {
      if (line && state.traceResponses) {
        writeTrace({
          direction: 'upstream_to_proxy',
          payload: line,
          suppressed: true,
          reason: 'hydrate_notification'
        });
      }
      return;
    }
    if (responseId && suppressedResponseIds.has(responseId)) {
      suppressedResponseIds.delete(responseId);
      const hydratedThreadId = hydrationResponseIdToThreadId.get(responseId);
      hydrationResponseIdToThreadId.delete(responseId);
      if (hydratedThreadId) {
        if (parsedResponse && parsedResponse.result && !parsedResponse.error) {
          liveThreadIds.add(hydratedThreadId);
        }
        const pendingHydration = pendingHydrationsByThreadId.get(hydratedThreadId);
        pendingHydrationsByThreadId.delete(hydratedThreadId);
        writeRemoteHydrationSuppressionState(
          fs,
          remoteControlProxy && remoteControlProxy.suppressStateFile,
          pendingHydrationsByThreadId
        );
        for (const pendingPayload of pendingHydration && pendingHydration.pendingPayloads || []) {
          markTurnStartPending(tryParseJson(pendingPayload));
          child.stdin.write(`${pendingPayload}\n`);
        }
        if (pendingHydration && pendingHydration.pendingPayloads.length > 0) {
          writeTrace({
            direction: 'proxy_internal',
            action: 'flush_queued_turn_payload_after_thread_hydrated',
            threadId: hydratedThreadId,
            flushed: pendingHydration.pendingPayloads.length
          });
        }
      }
      if (line && state.traceResponses) {
        writeTrace({
          direction: 'upstream_to_proxy',
          payload: line,
          suppressed: true
        });
      }
      return;
    }
    const aggregateContextId = responseId ? aggregateRequestIdToContextId.get(responseId) : '';
    if (aggregateContextId) {
      const context = aggregateContexts.get(aggregateContextId);
      if (context && parsedResponse && parsedResponse.result && typeof parsedResponse.result === 'object') {
        const result = parsedResponse.result;
        context.pagesFetched += 1;
        context.collectedData = mergeThreadListData(context.collectedData, result.data);
        if (!context.backwardsCursor && result.backwardsCursor) {
          context.backwardsCursor = result.backwardsCursor;
        }
        context.nextCursor = result.nextCursor || null;
        aggregateRequestIdToContextId.delete(responseId);
        const remainingItems = Math.max(
          0,
          AGGREGATE_THREAD_LIST_MAX_ITEMS - context.requestedItems
        );

        if (
          context.pagesFetched < AGGREGATE_THREAD_LIST_MAX_PAGES
          && context.nextCursor
          && remainingItems > 0
        ) {
          const nextRequestId = `aih-aggregate-thread-list:${context.originalId}:${context.pagesFetched + 1}`;
          const nextRequest = buildAggregatePageRequest(
            context.requestTemplate,
            context.nextCursor,
            nextRequestId,
            remainingItems
          );
          context.requestedItems += Number(nextRequest.params && nextRequest.params.limit) || 0;
          aggregateRequestIdToContextId.set(String(nextRequestId), aggregateContextId);
          writeTrace({
            direction: 'proxy_to_upstream',
            rewritten: JSON.stringify(nextRequest),
            aggregate: true,
            page: context.pagesFetched + 1
          });
          child.stdin.write(`${JSON.stringify(nextRequest)}\n`);
          return;
        }

        aggregateContexts.delete(aggregateContextId);
        let finalPayload = JSON.stringify({
          id: context.originalId,
          result: {
            data: context.collectedData,
            nextCursor: context.nextCursor,
            backwardsCursor: context.backwardsCursor
          }
        });
        finalPayload = patchThreadListVisibilityResponse(finalPayload, context.requestTemplate && context.requestTemplate.params
          ? {
            ...getThreadListRequestContext(context.requestTemplate),
            ...context.requestTemplate.params
          }
          : getThreadListRequestContext(context.requestTemplate), {
          fs,
          processObj,
          DatabaseSync: deps.DatabaseSync
        });
        finalPayload = patchThreadTitleFieldsResponse(finalPayload, {
          fs,
          processObj,
          DatabaseSync: deps.DatabaseSync
        });
        if (state.traceResponses) {
          writeTrace({
            direction: 'upstream_to_client',
            payload: finalPayload,
            aggregate: true,
            pagesFetched: context.pagesFetched
          });
        }
        if (state.traceRemoteControl === true) {
          writeTrace({
            direction: 'upstream_to_client',
            remoteControl: true,
            summary: summarizeJsonRpcForTrace(JSON.parse(finalPayload)),
            aggregate: true,
            pagesFetched: context.pagesFetched
          });
        }
        processObj.stdout.write(`${finalPayload}\n`);
        return;
      }
      aggregateRequestIdToContextId.delete(responseId);
      aggregateContexts.delete(aggregateContextId);
    }

    if (line && state.traceResponses) {
      writeTrace({
        direction: 'upstream_to_client',
        payload: line
      });
    }
    const patchContext = responseId ? responsePatchContexts.get(responseId) : null;
    if (responseId) responsePatchContexts.delete(responseId);
    const threadModelContext = responseId ? threadModelResponseContexts.get(responseId) : null;
    if (responseId) threadModelResponseContexts.delete(responseId);
    const shouldPatchAccountRead = responseId && accountReadResponseIds.has(responseId);
    if (responseId) accountReadResponseIds.delete(responseId);
    const authStatusContext = responseId ? authStatusResponseContexts.get(responseId) : null;
    if (responseId) authStatusResponseContexts.delete(responseId);
    const threadListContext = responseId ? threadListResponseContexts.get(responseId) : null;
    if (responseId) threadListResponseContexts.delete(responseId);
    const threadGoalGetContext = responseId ? threadGoalGetResponseContexts.get(responseId) : null;
    if (responseId) threadGoalGetResponseContexts.delete(responseId);
    let responsePayload = patchThreadResumeResponseMessage(line, threadResumeResponseContexts);
    responsePayload = patchThreadConfigResponse(responsePayload, patchContext);
    responsePayload = patchCodexThreadTurnModelsResponse(responsePayload, threadModelContext, { fs });
    if (shouldPatchAccountRead) {
      responsePayload = patchAccountReadResponse(responsePayload, {
        fs,
        processObj,
        os: deps.os,
        desktopAccountRef: state.desktopAccountRef
      });
    }
    if (authStatusContext) {
      responsePayload = patchAuthStatusResponse(responsePayload, authStatusContext, {
        fs,
        processObj,
        os: deps.os,
        desktopAccountRef: state.desktopAccountRef
      });
    }
    if (threadListContext) {
      responsePayload = patchThreadListVisibilityResponse(responsePayload, threadListContext, {
        fs,
        processObj,
        DatabaseSync: deps.DatabaseSync
      });
    }
    if (threadGoalGetContext) {
      responsePayload = patchThreadGoalGetResponse(responsePayload, threadGoalGetContext, {
        fs,
        processObj,
        DatabaseSync: deps.DatabaseSync
      });
    }
    responsePayload = patchThreadTitleFieldsResponse(responsePayload, {
      fs,
      processObj,
      DatabaseSync: deps.DatabaseSync
    });
    processObj.stdout.write(`${responsePayload}\n`);
  });

  processObj.stdin.on('data', (chunk) => stdinPump.write(chunk));
  processObj.stdin.on('end', () => {
    stdinPump.flush();
    if (child.stdin) child.stdin.end();
  });
  child.stdout.on('data', (chunk) => stdoutPump.write(chunk));
  child.stdout.on('end', () => stdoutPump.flush());
  if (child.stderr && typeof child.stderr.on === 'function') {
    const stderrPump = createLinePump((line) => {
      if (state.traceRemoteControl && isRemoteTraceStderrLine(line)) {
        writeTrace({
          direction: 'upstream_stderr',
          remoteControl: true,
          line: sanitizeTraceText(line)
        });
      }
    });
    child.stderr.on('data', (chunk) => {
      try { processObj.stderr.write(chunk); } catch (_error) {}
      stderrPump.write(chunk);
    });
    child.stderr.on('end', () => stderrPump.flush());
  }
  child.on('error', (error) => {
    processObj.stderr.write(`${String((error && error.message) || error || 'proxy_failed')}\n`);
    processObj.exit(1);
  });
  child.once('exit', () => {
    if (sessionNotificationPoller && typeof sessionNotificationPoller.stop === 'function') {
      sessionNotificationPoller.stop();
    }
  });
  forwardExitCode(child, processObj);
  return child;
}

if (require.main === module) {
  Promise.resolve()
    .then(() => runCodexAppServerStdioProxy(process.argv.slice(2)))
    .catch((error) => {
      process.stderr.write(`${String((error && error.message) || error || 'proxy_failed')}\n`);
      process.exit(1);
    });
}

module.exports = {
  AGGREGATE_THREAD_LIST_MAX_ITEMS,
  AGGREGATE_THREAD_LIST_MAX_PAGES,
  STATE_THREAD_LIST_CURSOR_PREFIX,
  DESKTOP_ACCOUNT_SYNC_INTERVAL_MS,
  FAST_THREAD_READ_MIN_BYTES,
  OPTIMIZED_ROLLOUT_REPAIR_INTERVAL_MS,
  shouldAggregateThreadList,
  buildAggregatePageRequest,
  buildFastResumeHydrationRequest,
  buildTurnStartHydrationRequest,
  buildTurnLiveThreadHydrationRequest,
  buildCodexAppServerSessionEvent,
  buildCodexThreadStatusNotification,
  createCodexAppServerSessionEventPublisher,
  createCodexDesktopAccountSyncController,
  createCodexSessionNotificationPoller,
  buildFastThreadReadResponse,
  buildCodexAppServerRuntimeConfig,
  buildCodexDesktopAccountLoginRequest,
  buildCodexAppServerSpawnEnv,
  buildStateThreadListResponse,
  buildCodexCliResumeArgs,
  mergeThreadListData,
  prepareCodexAppServerRuntimeHome,
  parseProxyArgs,
  patchAccountReadResponse,
  patchAuthStatusResponse,
  patchThreadTitleFieldsResponse,
  patchThreadConfigResponse,
  parseRecentCodexRolloutTurns,
  readHookState,
  runCodexCliResume,
  runCodexResumeVisibilityRepair,
  repairMissingOptimizedRolloutPaths,
  repairMissingThreadTitleFields,
  patchThreadListVisibilityResponse,
  readStateThreadListPage,
  rewriteThreadListVisibleSources,
  resolveCanonicalRolloutPath,
  restoreOptimizedRolloutPathInStateDbs,
  reconcileSelectedThreadConfig,
  reconcileResumeThreadProvider,
  rewriteThreadResumeRuntimeConfig,
  sanitizeTraceText,
  shouldSuppressHydrationNotification,
  summarizeJsonRpcForTrace,
  isRemoteTracePayload,
  startRemoteControlProxyProcess,
  runCodexAppServerStdioProxy
};
