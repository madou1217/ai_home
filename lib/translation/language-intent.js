'use strict';

// The only place where a translation request decides whether a language pair is
// safe to send upstream.  Keep this module pure: clients can mirror the same
// decision without loading the server, and the HTTP route can run it before it
// touches model/account state.

const {
  AUTO_LANGUAGE,
  isSupportedLanguage,
  normalizeLanguageCode
} = require('../server/translation-language');

const TARGET_POLICIES = new Set(['saved', 'explicit', 'confirm', 'same-language']);

function suppliedLanguage(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function unsupported(value) {
  return suppliedLanguage(value)
    && normalizeLanguageCode(value) === '';
}

/**
 * Resolve the source/target decision for one translation intent.
 *
 * `auto` is meaningful only for source. Adapters explicitly declaring automatic
 * source support may receive auto; all others still require a concrete code.
 *
 * @param {{source?: string|null, target?: string|null, detected?: string|null,
 *   confidence?: string|null, targetPolicy?: string|null, allowAutoSource?: boolean}} input
 * @returns {{state: 'ready'|'needs_target_confirmation'|'same_language'|'unsupported',
 *   source: string, target: string, reason: string}}
 */
function resolveLanguageIntent(input = {}) {
  const rawSource = suppliedLanguage(input.source) ? String(input.source).trim() : AUTO_LANGUAGE;
  const rawTarget = suppliedLanguage(input.target) ? String(input.target).trim() : '';
  const rawDetected = suppliedLanguage(input.detected) ? String(input.detected).trim() : '';
  const source = normalizeLanguageCode(rawSource);
  const target = normalizeLanguageCode(rawTarget);
  const detected = normalizeLanguageCode(rawDetected);
  const targetPolicy = TARGET_POLICIES.has(String(input.targetPolicy || ''))
    ? String(input.targetPolicy)
    : 'saved';

  if (unsupported(rawSource) || unsupported(rawTarget) || unsupported(rawDetected)) {
    return { state: 'unsupported', source: '', target: '', reason: 'unsupported_language' };
  }
  if (source !== AUTO_LANGUAGE && !isSupportedLanguage(source)) {
    return { state: 'unsupported', source: '', target: '', reason: 'unsupported_source' };
  }
  if (target && target !== AUTO_LANGUAGE && !isSupportedLanguage(target)) {
    return { state: 'unsupported', source: '', target: '', reason: 'unsupported_target' };
  }
  if (!target || target === AUTO_LANGUAGE) {
    return {
      state: 'needs_target_confirmation',
      source: source === AUTO_LANGUAGE ? detected : source,
      target: '',
      reason: 'target_required'
    };
  }

  if (source === AUTO_LANGUAGE && input.allowAutoSource === true && targetPolicy !== 'confirm') {
    return { state: 'ready', source: AUTO_LANGUAGE, target, reason: 'provider_auto_source' };
  }

  const resolvedSource = source === AUTO_LANGUAGE ? detected : source;
  if (!resolvedSource || !isSupportedLanguage(resolvedSource)) {
    return {
      state: 'needs_target_confirmation',
      source: resolvedSource || '',
      target,
      reason: 'source_detection_required'
    };
  }
  if (String(input.confidence || '').toLowerCase() === 'low' && targetPolicy !== 'explicit') {
    return {
      state: 'needs_target_confirmation',
      source: resolvedSource,
      target,
      reason: 'low_confidence'
    };
  }
  if (resolvedSource === target && targetPolicy !== 'explicit') {
    return {
      state: 'same_language',
      source: resolvedSource,
      target,
      reason: 'same_language'
    };
  }
  return { state: 'ready', source: resolvedSource, target, reason: 'ready' };
}

module.exports = { TARGET_POLICIES, resolveLanguageIntent };
