'use strict';

function normalizeString(value) {
  return String(value || '').trim();
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function hasOwnProperty(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeRequiredKeys(required) {
  if (!Array.isArray(required)) return [];
  return required
    .map(normalizeString)
    .filter((key, index, keys) => key && keys.indexOf(key) === index);
}

function readToolSchemaFromDeclaration(tool, schemaKey = '') {
  if (!tool || typeof tool !== 'object') return null;
  const fn = tool.function && typeof tool.function === 'object' ? tool.function : null;
  const directKey = normalizeString(schemaKey);
  if (directKey && tool[directKey] && typeof tool[directKey] === 'object') {
    return tool[directKey];
  }
  return (
    tool.input_schema
    || tool.inputSchema
    || tool.parameters
    || tool.parametersJsonSchema
    || tool.schema
    || (fn && (fn.parameters || fn.parametersJsonSchema || fn.schema))
    || null
  );
}

function readRequiredKeysFromToolDeclaration(tool, schemaKey = '') {
  const schema = readToolSchemaFromDeclaration(tool, schemaKey);
  return normalizeRequiredKeys(schema && schema.required);
}

function readToolNameFromDeclaration(tool) {
  if (!tool || typeof tool !== 'object') return '';
  const fn = tool.function && typeof tool.function === 'object' ? tool.function : null;
  return normalizeString(
    tool.name
    || tool.toolName
    || tool.id
    || (fn && fn.name)
  );
}

function collectToolRequirementsFromDeclarations(value, requirements = new Map()) {
  if (!Array.isArray(value)) return requirements;
  value.forEach((tool) => {
    if (!tool || typeof tool !== 'object') return;
    const functionDeclarations = Array.isArray(tool.functionDeclarations)
      ? tool.functionDeclarations
      : Array.isArray(tool.function_declarations)
        ? tool.function_declarations
        : null;
    if (functionDeclarations) {
      collectToolRequirementsFromDeclarations(functionDeclarations, requirements);
      return;
    }
    const toolName = readToolNameFromDeclaration(tool);
    const required = readRequiredKeysFromToolDeclaration(tool);
    if (toolName && required.length > 0) requirements.set(toolName, required);
  });
  return requirements;
}

function createRequiredToolLookup(functionDeclarations, schemaKey = '') {
  const requiredByName = new Map();
  (Array.isArray(functionDeclarations) ? functionDeclarations : []).forEach((declaration) => {
    if (!declaration || typeof declaration !== 'object') return;
    const name = readToolNameFromDeclaration(declaration);
    if (!name) return;
    requiredByName.set(name, readRequiredKeysFromToolDeclaration(declaration, schemaKey));
  });
  return requiredByName;
}

function readRequiredToolInputs(requiredByName, toolName) {
  if (!(requiredByName instanceof Map)) return [];
  const required = requiredByName.get(normalizeString(toolName));
  return Array.isArray(required) ? required : [];
}

function parseFunctionCallInput(functionCall) {
  const args = functionCall && functionCall.args;
  if (args && typeof args === 'object' && !Array.isArray(args)) return args;
  return parseJsonObject(args) || {};
}

function getFunctionCallArgsDiagnostic(functionCall) {
  if (!functionCall || typeof functionCall !== 'object' || !hasOwnProperty(functionCall, 'args')) return null;
  const args = functionCall.args;
  if (args && typeof args === 'object' && !Array.isArray(args)) return null;
  if (typeof args === 'string') {
    const text = args.trim();
    if (!text || parseJsonObject(text)) return null;
    return {
      argsKind: 'string',
      argumentLength: args.length,
      reason: 'invalid_json_object'
    };
  }
  if (args == null) return null;
  return {
    argsKind: Array.isArray(args) ? 'array' : typeof args,
    argumentLength: normalizeString(args).length,
    reason: 'non_object_args'
  };
}

function validateFunctionCallInput(functionCall, requiredByName) {
  const name = normalizeString(functionCall && functionCall.name);
  const input = parseFunctionCallInput(functionCall);
  const missingRequired = readRequiredToolInputs(requiredByName, name)
    .filter((key) => !hasOwnProperty(input, key));
  const argsDiagnostic = getFunctionCallArgsDiagnostic(functionCall);
  const ok = missingRequired.length === 0 && !argsDiagnostic;
  return {
    ok,
    input,
    ...(ok ? {} : {
      diagnostic: {
        type: 'tool_call_invalid_input',
        id: normalizeString(functionCall && functionCall.id),
        name,
        ...(missingRequired.length > 0 ? { missingRequired } : {}),
        ...(argsDiagnostic || {})
      }
    })
  };
}

function formatInvalidToolCallText(diagnostics) {
  const items = (Array.isArray(diagnostics) ? diagnostics : [])
    .map((item) => {
      const name = normalizeString(item && item.name) || 'unknown_tool';
      const missing = Array.isArray(item && item.missingRequired) && item.missingRequired.length > 0
        ? ` missing required input: ${item.missingRequired.join(', ')}`
        : '';
      const unexpected = Array.isArray(item && item.unexpectedInput) && item.unexpectedInput.length > 0
        ? ` unexpected input: ${item.unexpectedInput.join(', ')}`
        : '';
      const reason = normalizeString(item && item.reason);
      return `${name}${missing}${unexpected}${reason ? ` (${reason})` : ''}`;
    })
    .filter(Boolean);
  if (items.length === 0) return '';
  return `Upstream returned invalid tool call input; suppressed execution for: ${items.join('; ')}`;
}

module.exports = {
  collectToolRequirementsFromDeclarations,
  createRequiredToolLookup,
  formatInvalidToolCallText,
  getFunctionCallArgsDiagnostic,
  hasOwnProperty,
  normalizeRequiredKeys,
  parseFunctionCallInput,
  parseJsonObject,
  readRequiredKeysFromToolDeclaration,
  readRequiredToolInputs,
  readToolNameFromDeclaration,
  readToolSchemaFromDeclaration,
  validateFunctionCallInput
};
