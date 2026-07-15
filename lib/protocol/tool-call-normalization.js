'use strict';

const {
  getFunctionCallArgsDiagnostic,
  hasOwnProperty,
  parseFunctionCallInput,
  readRequiredToolInputs,
  readToolNameFromDeclaration,
  readToolSchemaFromDeclaration
} = require('./tool-call-validation');

const TOOL_INPUT_ALIAS_RULES = Object.freeze([
  {
    toolName: 'Write',
    targetKey: 'content',
    sourceKeys: ['write_content', 'file_content', 'text']
  },
  {
    toolName: 'Edit',
    targetKey: 'new_string',
    sourceKeys: ['replace_string']
  },
  {
    // Claude Read uses `limit` as the line-count parameter.
    toolName: 'Read',
    targetKey: 'limit',
    sourceKeys: ['lines_required']
  }
]);

const TASK_CREATE_CONTEXT_KEYS = Object.freeze(['subject', 'description']);
const AGENT_PROMPT_SOURCE_KEYS = Object.freeze(['message', 'args']);
const AGENT_DESCRIPTION_MAX_LENGTH = 180;

function normalizeString(value) {
  return String(value || '').trim();
}

function createToolSchemaLookup(functionDeclarations, schemaKey = '') {
  const schemaByName = new Map();
  (Array.isArray(functionDeclarations) ? functionDeclarations : []).forEach((declaration) => {
    if (!declaration || typeof declaration !== 'object') return;
    const name = readToolNameFromDeclaration(declaration);
    if (!name) return;
    const schema = readToolSchemaFromDeclaration(declaration, schemaKey);
    if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
      schemaByName.set(name, schema);
    }
  });
  return schemaByName;
}

function readToolSchema(schemaByName, toolName) {
  if (!(schemaByName instanceof Map)) return null;
  const schema = schemaByName.get(normalizeString(toolName));
  return schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : null;
}

function readPropertyKeys(schema) {
  const properties = schema && schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties
    : null;
  return properties ? Object.keys(properties).filter(Boolean) : [];
}

function schemaAllowsTargetKey(schema, requiredKeys, targetKey) {
  const key = normalizeString(targetKey);
  if (!key) return false;
  const properties = readPropertyKeys(schema);
  if (properties.length > 0) return properties.includes(key);
  if ((Array.isArray(requiredKeys) ? requiredKeys : []).includes(key)) return true;
  return !schema;
}

function applyAliasRules(toolName, input, schema, requiredKeys) {
  const name = normalizeString(toolName);
  let nextInput = input;
  const normalizedKeys = [];
  const removedKeys = [];
  const aliasMappings = [];
  const normalizationReasons = [];

  TOOL_INPUT_ALIAS_RULES.forEach((rule) => {
    if (rule.toolName !== name) return;
    if (hasOwnProperty(nextInput, rule.targetKey)) return;
    if (!schemaAllowsTargetKey(schema, requiredKeys, rule.targetKey)) return;
    const sourceKey = rule.sourceKeys.find((key) => hasOwnProperty(nextInput, key));
    if (!sourceKey) return;
    nextInput = { ...nextInput, [rule.targetKey]: nextInput[sourceKey] };
    delete nextInput[sourceKey];
    normalizedKeys.push(rule.targetKey);
    removedKeys.push(sourceKey);
    aliasMappings.push({ from: sourceKey, to: rule.targetKey });
    normalizationReasons.push('alias_mapped');
  });

  return {
    input: nextInput,
    normalizedKeys,
    removedKeys,
    aliasMappings,
    normalizationReasons
  };
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function readAgentPromptAlias(input) {
  if (hasOwnProperty(input, 'message')) {
    const message = normalizeString(input.message);
    if (message) return { sourceKey: 'message', value: message };
  }
  if (typeof input.args === 'string') {
    const args = normalizeString(input.args);
    if (args) return { sourceKey: 'args', value: args };
  }
  return null;
}

function stripMarkdownLine(value) {
  let text = normalizeString(value)
    .replace(/^#{1,6}\s+/, '')
    .trim();
  const bold = text.match(/^\*\*(.+?)\*\*:?$/);
  if (bold) text = bold[1].trim();
  text = text.replace(/^[>\-\s]+/, '').trim();
  return text;
}

function deriveTaskCreateInputFromContext(contextText) {
  const rawLines = String(contextText == null ? '' : contextText)
    .split(/\r?\n/)
    .map((line) => line.trim());
  const firstIndex = rawLines.findIndex((line) => Boolean(line));
  if (firstIndex < 0) return null;

  const subject = stripMarkdownLine(rawLines[firstIndex]).slice(0, 180);
  const description = rawLines
    .slice(firstIndex + 1)
    .join('\n')
    .trim()
    .slice(0, 4000);
  if (!subject || !description) return null;
  return { subject, description };
}

function deriveAgentDescriptionFromPrompt(prompt) {
  const lines = String(prompt == null ? '' : prompt)
    .split(/\r?\n/)
    .map(stripMarkdownLine)
    .filter(Boolean);
  if (lines.length === 0) return '';
  return lines[0].slice(0, AGENT_DESCRIPTION_MAX_LENGTH);
}

function applyAgentInputRule(toolName, input, schema, requiredKeys) {
  const name = normalizeString(toolName);
  if (name !== 'Agent') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  let nextInput = input;
  const normalizedKeys = [];
  const removedKeys = [];
  const aliasMappings = [];
  const normalizationReasons = [];
  const promptAlias = !hasOwnProperty(nextInput, 'prompt') ? readAgentPromptAlias(nextInput) : null;

  if (promptAlias && schemaAllowsTargetKey(schema, requiredKeys, 'prompt')) {
    nextInput = { ...nextInput, prompt: promptAlias.value };
    normalizedKeys.push('prompt');
    aliasMappings.push({ from: promptAlias.sourceKey, to: 'prompt' });
    normalizationReasons.push('alias_mapped');
  }

  AGENT_PROMPT_SOURCE_KEYS.forEach((key) => {
    if (!hasOwnProperty(nextInput, key)) return;
    if (schema && schemaAllowsTargetKey(schema, requiredKeys, key)) return;
    if (nextInput === input) nextInput = { ...nextInput };
    delete nextInput[key];
    pushUnique(removedKeys, key);
  });

  if (
    !hasOwnProperty(nextInput, 'description')
    && schemaAllowsTargetKey(schema, requiredKeys, 'description')
  ) {
    const description = deriveAgentDescriptionFromPrompt(nextInput.prompt);
    if (description) {
      if (nextInput === input) nextInput = { ...nextInput };
      nextInput.description = description;
      normalizedKeys.push('description');
      normalizationReasons.push('derived');
    }
  }

  if (normalizedKeys.length === 0 && removedKeys.length === 0) return null;
  return {
    input: nextInput,
    normalizedKeys,
    removedKeys,
    aliasMappings,
    normalizationReasons
  };
}

function applyTaskCreateContextRule(toolName, input, schema, requiredKeys, options = {}) {
  const name = normalizeString(toolName);
  if (name !== 'TaskCreate') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (Object.keys(input).length > 0) return null;
  const allowsRequiredKeys = TASK_CREATE_CONTEXT_KEYS.every((key) => (
    schemaAllowsTargetKey(schema, requiredKeys, key)
  ));
  if (!allowsRequiredKeys) return null;

  const derived = deriveTaskCreateInputFromContext(
    options.contextText || options.toolContextText || ''
  );
  if (!derived) return null;
  return {
    input: { ...input, ...derived },
    normalizedKeys: TASK_CREATE_CONTEXT_KEYS.slice(),
    removedKeys: [],
    aliasMappings: [],
    normalizationReasons: ['context_derived']
  };
}

function applyToolInputNormalizations(toolName, input, schema, requiredKeys, options = {}) {
  const aliasResult = applyAliasRules(toolName, input, schema, requiredKeys);
  const agentResult = applyAgentInputRule(
    toolName,
    aliasResult.input,
    schema,
    requiredKeys
  );
  const baseResult = agentResult
    ? {
        input: agentResult.input,
        normalizedKeys: [...aliasResult.normalizedKeys, ...agentResult.normalizedKeys],
        removedKeys: [...aliasResult.removedKeys, ...agentResult.removedKeys],
        aliasMappings: [...aliasResult.aliasMappings, ...agentResult.aliasMappings],
        normalizationReasons: [...aliasResult.normalizationReasons, ...agentResult.normalizationReasons]
      }
    : aliasResult;
  const contextResult = applyTaskCreateContextRule(
    toolName,
    baseResult.input,
    schema,
    requiredKeys,
    options
  );
  if (!contextResult) return baseResult;
  return {
    input: contextResult.input,
    normalizedKeys: [...baseResult.normalizedKeys, ...contextResult.normalizedKeys],
    removedKeys: baseResult.removedKeys,
    aliasMappings: baseResult.aliasMappings,
    normalizationReasons: [...baseResult.normalizationReasons, ...contextResult.normalizationReasons]
  };
}

function normalizeToolCallInput(toolName, input, options = {}) {
  const rawInput = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const schema = options.schema && typeof options.schema === 'object' && !Array.isArray(options.schema)
    ? options.schema
    : null;
  const requiredKeys = Array.isArray(options.requiredKeys) ? options.requiredKeys : [];
  return applyToolInputNormalizations(toolName, rawInput, schema, requiredKeys, options);
}

function resolveNormalizationReason(normalization) {
  const reasons = Array.isArray(normalization && normalization.normalizationReasons)
    ? normalization.normalizationReasons.filter(Boolean)
    : [];
  return reasons[0] || 'alias_mapped';
}

function isStrictObjectSchema(schema) {
  return Boolean(
    schema
    && typeof schema === 'object'
    && !Array.isArray(schema)
    && (
      schema.additionalProperties === false
      || schema.unevaluatedProperties === false
    )
  );
}

function collectUnexpectedInputKeys(input, schema) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  if (!isStrictObjectSchema(schema)) return [];
  const allowed = new Set(readPropertyKeys(schema));
  return Object.keys(input).filter((key) => !allowed.has(key));
}

function buildInvalidToolInputDiagnostic(functionCall, details) {
  const argsDiagnostic = details.argsDiagnostic || null;
  return {
    type: 'tool_call_invalid_input',
    id: normalizeString(functionCall && functionCall.id),
    name: normalizeString(functionCall && functionCall.name),
    ...(details.missingKeys.length > 0 ? { missingRequired: details.missingKeys } : {}),
    ...(details.unexpectedKeys.length > 0 ? { unexpectedInput: details.unexpectedKeys } : {}),
    ...(argsDiagnostic || {})
  };
}

function resolveRejectionReason(argsDiagnostic, missingKeys, unexpectedKeys) {
  if (argsDiagnostic && argsDiagnostic.reason) return argsDiagnostic.reason;
  if (missingKeys.length > 0) return 'missing_required';
  if (unexpectedKeys.length > 0) return 'unexpected_input';
  return '';
}

function evaluateFunctionCallInput(functionCall, requiredByName, schemaByName, options = {}) {
  const name = normalizeString(functionCall && functionCall.name);
  const rawInput = parseFunctionCallInput(functionCall);
  const argsDiagnostic = getFunctionCallArgsDiagnostic(functionCall);
  const requiredKeys = readRequiredToolInputs(requiredByName, name);
  const schema = readToolSchema(schemaByName, name);
  const normalization = argsDiagnostic
    ? { input: rawInput, normalizedKeys: [], removedKeys: [], aliasMappings: [], normalizationReasons: [] }
    : applyToolInputNormalizations(name, rawInput, schema, requiredKeys, options);
  const input = normalization.input;
  const missingKeys = requiredKeys.filter((key) => !hasOwnProperty(input, key));
  const unexpectedKeys = collectUnexpectedInputKeys(input, schema);
  const ok = !argsDiagnostic && missingKeys.length === 0 && unexpectedKeys.length === 0;
  const action = ok
    ? (normalization.normalizedKeys.length > 0 ? 'normalized' : 'passed')
    : 'rejected';
  const reason = ok
    ? (normalization.normalizedKeys.length > 0 ? resolveNormalizationReason(normalization) : '')
    : resolveRejectionReason(argsDiagnostic, missingKeys, unexpectedKeys);

  return {
    ok,
    input,
    action,
    reason,
    argKeys: Object.keys(rawInput),
    inputKeys: Object.keys(input),
    requiredKeys,
    normalizedKeys: normalization.normalizedKeys,
    removedKeys: normalization.removedKeys,
    aliasMappings: normalization.aliasMappings,
    missingKeys,
    unexpectedKeys,
    ...(ok ? {} : {
      diagnostic: buildInvalidToolInputDiagnostic(functionCall, {
        argsDiagnostic,
        missingKeys,
        unexpectedKeys
      })
    })
  };
}

module.exports = {
  collectUnexpectedInputKeys,
  createToolSchemaLookup,
  deriveTaskCreateInputFromContext,
  evaluateFunctionCallInput,
  normalizeToolCallInput
};
