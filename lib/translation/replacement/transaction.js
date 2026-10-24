'use strict';

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TEXT_CHARS = 200000;

class ReplacementTransactionError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ReplacementTransactionError';
    this.code = code;
  }
}

function normalizeText(value, field) {
  const text = String(value == null ? '' : value);
  if (!text.trim()) throw new ReplacementTransactionError(`replacement_${field}_required`);
  if (text.length > MAX_TEXT_CHARS) throw new ReplacementTransactionError('replacement_text_too_large');
  return text;
}

function normalizeSelection(selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw new ReplacementTransactionError('replacement_selection_required');
  }
  const id = String(selection.id || selection.selectionId || '').trim();
  const revision = Number(selection.revision);
  if (!id || !Number.isSafeInteger(revision) || revision < 0) {
    throw new ReplacementTransactionError('replacement_selection_identity_required');
  }
  return Object.freeze({
    id,
    revision,
    text: String(selection.text == null ? '' : selection.text),
    anchor: selection.anchor && typeof selection.anchor === 'object' ? Object.freeze({ ...selection.anchor }) : null
  });
}

function replacementSteps(text, options = {}) {
  const target = String(text == null ? '' : text);
  const chunkSize = Math.max(1, Math.min(32, Math.floor(Number(options.chunkSize) || 1)));
  const steps = [];
  for (let length = chunkSize; length < target.length; length += chunkSize) steps.push(target.slice(0, length));
  steps.push(target);
  return steps;
}

function nowValue(now) {
  return typeof now === 'function' ? Number(now()) : Date.now();
}

function createReplacementTransaction(input = {}) {
  const host = input.host;
  if (!host || typeof host.read !== 'function' || typeof host.replace !== 'function') {
    throw new ReplacementTransactionError('replacement_host_adapter_required');
  }
  const originalText = normalizeText(input.sourceText, 'source');
  const translatedText = normalizeText(input.translatedText, 'translated');
  const selection = normalizeSelection(input.selection);
  if (selection.text && selection.text !== originalText) {
    throw new ReplacementTransactionError('replacement_snapshot_mismatch');
  }
  const createdAt = nowValue(input.now);
  const ttlMs = Math.max(1000, Math.min(30 * 60 * 1000, Number(input.ttlMs) || DEFAULT_TTL_MS));
  const id = String(input.id || (typeof input.idFactory === 'function' ? input.idFactory() : '') || `replace-${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  let state = 'prepared';
  let appliedAt = 0;
  let appliedRevision = null;

  function snapshot() {
    return Object.freeze({ id, state, createdAt, expiresAt: createdAt + ttlMs, appliedAt, selection, sourceLength: originalText.length, translatedLength: translatedText.length });
  }

  function ensureLive() {
    if (state === 'undone' || state === 'cancelled') throw new ReplacementTransactionError(`replacement_${state}`);
    if (nowValue(input.now) > createdAt + ttlMs) {
      state = 'cancelled';
      throw new ReplacementTransactionError('replacement_expired');
    }
  }

  async function readCurrent() {
    const current = await host.read(selection);
    if (!current || typeof current !== 'object') throw new ReplacementTransactionError('replacement_host_snapshot_invalid');
    return current;
  }

  function assertCurrent(current, expectedText, conflictCode = 'replacement_conflict', expectedRevision = selection.revision) {
    const currentId = String(current.id || current.selectionId || '').trim();
    const currentRevision = Number(current.revision);
    const currentText = String(current.text == null ? '' : current.text);
    if (currentId !== selection.id || currentRevision !== expectedRevision || currentText !== expectedText) {
      state = 'conflict';
      throw new ReplacementTransactionError(conflictCode);
    }
  }

  async function apply(options = {}) {
    ensureLive();
    if (state !== 'prepared') throw new ReplacementTransactionError('replacement_already_applied');
    const current = await readCurrent();
    assertCurrent(current, originalText);
    const result = await host.replace(selection, translatedText, {
      transactionId: id,
      animate: options.animate !== false,
      steps: replacementSteps(translatedText, { chunkSize: options.chunkSize })
    });
    if (result && result.ok === false) throw new ReplacementTransactionError('replacement_apply_failed');
    const after = await readCurrent().catch(() => null);
    appliedRevision = after && Number.isSafeInteger(Number(after.revision)) ? Number(after.revision) : null;
    state = 'applied';
    appliedAt = nowValue(input.now);
    return snapshot();
  }

  async function undo() {
    if (state !== 'applied') throw new ReplacementTransactionError('replacement_not_applied');
    ensureLive();
    const current = await readCurrent();
    assertCurrent(current, translatedText, 'replacement_undo_conflict', appliedRevision === null ? Number(current.revision) : appliedRevision);
    if (appliedRevision !== null && Number(current.revision) !== appliedRevision) {
      state = 'conflict';
      throw new ReplacementTransactionError('replacement_undo_conflict');
    }
    if (typeof host.undo === 'function') {
      const result = await host.undo(selection, { transactionId: id, sourceText: originalText });
      if (result && result.ok === false) throw new ReplacementTransactionError('replacement_undo_failed');
    } else {
      const result = await host.replace(selection, originalText, { transactionId: id, undo: true, animate: false, steps: [originalText] });
      if (result && result.ok === false) throw new ReplacementTransactionError('replacement_undo_failed');
    }
    state = 'undone';
    return snapshot();
  }

  function cancel() {
    if (state === 'prepared') state = 'cancelled';
    return snapshot();
  }

  return Object.freeze({ id, selection, sourceText: originalText, translatedText, replacementSteps: () => replacementSteps(translatedText), snapshot, apply, undo, cancel });
}

module.exports = { DEFAULT_TTL_MS, MAX_TEXT_CHARS, ReplacementTransactionError, createReplacementTransaction, replacementSteps };
