import {
  collectRunningSessionKeys,
  findActiveRunKeyForSession,
} from '@/components/chat/active-run-state.js';

const runs = new Map();
const activeRunsRef = { current: runs };
const listeners = new Set();
let statusByKey = {};
let promptsByKey = {};
let snapshot = createSnapshot();

function createSnapshot() {
  return {
    runningSessionKeys: collectRunningSessionKeys(runs.values()),
    statusByKey,
    promptsByKey,
  };
}

function publish() {
  snapshot = createSnapshot();
  listeners.forEach((listener) => listener());
}

function find(session) {
  return findActiveRunKeyForSession(session, runs.values());
}

function register(run) {
  runs.set(run.runKey, run);
  publish();
}

function rename(previousRunKey, nextRunKey, patch = {}) {
  const current = runs.get(previousRunKey);
  if (!current) return previousRunKey;
  runs.delete(previousRunKey);
  runs.set(nextRunKey, { ...current, ...patch, runKey: nextRunKey });
  statusByKey = moveKey(statusByKey, previousRunKey, nextRunKey);
  promptsByKey = moveKey(promptsByKey, previousRunKey, nextRunKey);
  publish();
  return nextRunKey;
}

function update(runKey, patch) {
  const current = runs.get(runKey);
  if (current) runs.set(runKey, { ...current, ...patch });
}

function unregister(runKey) {
  if (!runs.delete(runKey)) return;
  statusByKey = omitKey(statusByKey, runKey);
  promptsByKey = omitKey(promptsByKey, runKey);
  publish();
}

function updateStatus(runKey, statusText) {
  if (statusByKey[runKey] === statusText) return;
  statusByKey = { ...statusByKey, [runKey]: statusText };
  publish();
}

function setPrompt(runKey, prompt) {
  promptsByKey = { ...promptsByKey, [runKey]: prompt };
  publish();
}

function restorePrompt(runKey, prompt) {
  if (promptsByKey[runKey]) return;
  setPrompt(runKey, prompt);
}

function clearPrompt(runKey, promptId) {
  const prompt = promptsByKey[runKey];
  if (!prompt || (promptId !== undefined && prompt.promptId !== promptId)) return;
  promptsByKey = omitKey(promptsByKey, runKey);
  publish();
}

function promptForKey(runKey) {
  return promptsByKey[runKey] || null;
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function omitKey(state, key) {
  if (!(key in state)) return state;
  const next = { ...state };
  delete next[key];
  return next;
}

function moveKey(state, fromKey, toKey) {
  const value = state[fromKey];
  return value ? { ...omitKey(state, fromKey), [toKey]: value } : state;
}

export const legacyActiveRunStore = {
  activeRunsRef,
  clearPrompt,
  find,
  getSnapshot: () => snapshot,
  promptForKey,
  register,
  rename,
  restorePrompt,
  setPrompt,
  subscribe,
  unregister,
  update,
  updateStatus,
};
