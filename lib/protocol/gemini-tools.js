'use strict';

function toPlainText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function createGeminiFunctionDeclaration(name, description, schema) {
  const safeName = toPlainText(name || '').trim();
  if (!safeName) return null;
  return {
    name: safeName,
    description: toPlainText(description || ''),
    parametersJsonSchema: schema && typeof schema === 'object'
      ? schema
      : { type: 'object', properties: {} }
  };
}

function wrapGeminiFunctionDeclarations(declarations) {
  const list = (Array.isArray(declarations) ? declarations : []).filter(Boolean);
  return list.length > 0 ? [{ functionDeclarations: list }] : [];
}

function createGeminiToolConfig(mode, allowedFunctionName) {
  const safeMode = toPlainText(mode || '').trim().toUpperCase();
  if (!safeMode) return undefined;
  const name = toPlainText(allowedFunctionName || '').trim();
  return {
    functionCallingConfig: {
      mode: safeMode,
      ...(name ? { allowedFunctionNames: [name] } : {})
    }
  };
}

function mapToolName(name, options = {}) {
  const rawName = toPlainText(name || '').trim();
  if (!rawName) return '';
  if (typeof options.mapName !== 'function') return rawName;
  return toPlainText(options.mapName(rawName) || '').trim();
}

function mapAnthropicToolsToGemini(tools) {
  return wrapGeminiFunctionDeclarations((Array.isArray(tools) ? tools : []).map((tool) => {
    if (!tool || typeof tool !== 'object') return null;
    return createGeminiFunctionDeclaration(tool.name, tool.description, tool.input_schema);
  }));
}

function mapAnthropicToolChoiceToGemini(toolChoice, options = {}) {
  if (typeof toolChoice === 'string') {
    const type = toolChoice.trim().toLowerCase();
    if (!type || type === 'auto') return createGeminiToolConfig('AUTO');
    if (type === 'none') return createGeminiToolConfig('NONE');
    if (type === 'any') return createGeminiToolConfig('ANY');
    return undefined;
  }
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  const type = String(toolChoice.type || '').trim().toLowerCase();
  if (!type) return createGeminiToolConfig('AUTO');
  if (type === 'none') return createGeminiToolConfig('NONE');
  if (type === 'auto') return createGeminiToolConfig('AUTO');
  if (type === 'any') return createGeminiToolConfig('ANY');
  if (type === 'tool') {
    const name = mapToolName(toolChoice.name, options);
    return name ? createGeminiToolConfig('ANY', name) : undefined;
  }
  return undefined;
}

function mapOpenAIToolsToGemini(tools) {
  return wrapGeminiFunctionDeclarations((Array.isArray(tools) ? tools : []).map((tool) => {
    if (!tool || tool.type !== 'function') return null;
    const fn = tool.function && typeof tool.function === 'object' ? tool.function : {};
    return createGeminiFunctionDeclaration(fn.name, fn.description, fn.parameters);
  }));
}

function mapOpenAIToolChoiceToGemini(toolChoice) {
  if (toolChoice === undefined) return undefined;
  if (typeof toolChoice === 'string') {
    const type = toolChoice.trim().toLowerCase();
    if (type === 'none') return createGeminiToolConfig('NONE');
    if (type === 'required' || type === 'any') return createGeminiToolConfig('ANY');
    if (!type || type === 'auto') return createGeminiToolConfig('AUTO');
    return undefined;
  }
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  const type = toPlainText(toolChoice.type || '').trim().toLowerCase();
  if (type === 'none') return createGeminiToolConfig('NONE');
  if (type === 'required' || type === 'any') return createGeminiToolConfig('ANY');
  if (!type || type === 'auto') return createGeminiToolConfig('AUTO');
  if (type === 'function' || type === 'tool') {
    const fn = toolChoice.function && typeof toolChoice.function === 'object'
      ? toolChoice.function
      : toolChoice;
    const name = toPlainText(fn.name || '').trim();
    return name ? createGeminiToolConfig('ANY', name) : undefined;
  }
  return undefined;
}

function readGeminiToolSchema(declaration) {
  if (declaration && declaration.parameters && typeof declaration.parameters === 'object') return declaration.parameters;
  if (declaration && declaration.parametersJsonSchema && typeof declaration.parametersJsonSchema === 'object') {
    return declaration.parametersJsonSchema;
  }
  return { type: 'object', properties: {} };
}

function collectGeminiFunctionDeclarations(tools) {
  const declarations = [];
  (Array.isArray(tools) ? tools : []).forEach((tool) => {
    const functionDeclarations = Array.isArray(tool && tool.functionDeclarations)
      ? tool.functionDeclarations
      : Array.isArray(tool && tool.function_declarations)
        ? tool.function_declarations
        : [];
    functionDeclarations.forEach((declaration) => {
      if (!declaration || typeof declaration !== 'object') return;
      const name = toPlainText(declaration.name || '').trim();
      if (!name) return;
      declarations.push({
        name,
        description: toPlainText(declaration.description || ''),
        schema: readGeminiToolSchema(declaration)
      });
    });
  });
  return declarations;
}

function mapGeminiToolsToOpenAI(tools) {
  return collectGeminiFunctionDeclarations(tools).map((declaration) => ({
    type: 'function',
    function: {
      name: declaration.name,
      description: declaration.description,
      parameters: declaration.schema
    }
  }));
}

function mapGeminiToolsToAnthropic(tools) {
  return collectGeminiFunctionDeclarations(tools).map((declaration) => ({
    name: declaration.name,
    description: declaration.description,
    input_schema: declaration.schema
  }));
}

function mapGeminiToolsToOpenAIResponses(tools) {
  return collectGeminiFunctionDeclarations(tools).map((declaration) => ({
    type: 'function',
    name: declaration.name,
    description: declaration.description,
    parameters: declaration.schema
  }));
}

function readGeminiFunctionCallingConfig(toolConfig) {
  const cfg = toolConfig && typeof toolConfig === 'object'
    ? (toolConfig.functionCallingConfig || toolConfig.function_calling_config || null)
    : null;
  return cfg && typeof cfg === 'object' ? cfg : null;
}

function readGeminiAllowedFunctionNames(cfg) {
  return Array.isArray(cfg && cfg.allowedFunctionNames)
    ? cfg.allowedFunctionNames
    : Array.isArray(cfg && cfg.allowed_function_names)
      ? cfg.allowed_function_names
      : [];
}

function mapGeminiToolConfigToOpenAI(toolConfig) {
  const cfg = readGeminiFunctionCallingConfig(toolConfig);
  if (!cfg) return undefined;
  const mode = String(cfg.mode || '').trim().toUpperCase();
  if (mode === 'NONE') return 'none';
  if (mode === 'ANY') {
    const allowed = readGeminiAllowedFunctionNames(cfg);
    const name = toPlainText(allowed[0] || '').trim();
    if (name) return { type: 'function', function: { name } };
    return 'required';
  }
  if (mode === 'AUTO') return 'auto';
  return undefined;
}

function mapGeminiToolConfigToAnthropic(toolConfig) {
  const cfg = readGeminiFunctionCallingConfig(toolConfig);
  if (!cfg) return undefined;
  const mode = String(cfg.mode || '').trim().toUpperCase();
  if (mode === 'NONE') return { type: 'none' };
  if (mode === 'ANY') {
    const name = toPlainText(readGeminiAllowedFunctionNames(cfg)[0] || '').trim();
    if (name) return { type: 'tool', name };
    return { type: 'any' };
  }
  if (mode === 'AUTO') return { type: 'auto' };
  return undefined;
}

function mapGeminiToolConfigToOpenAIResponses(toolConfig) {
  const cfg = readGeminiFunctionCallingConfig(toolConfig);
  if (!cfg) return undefined;
  const mode = String(cfg.mode || '').trim().toUpperCase();
  if (mode === 'NONE') return 'none';
  if (mode === 'ANY') {
    const name = toPlainText(readGeminiAllowedFunctionNames(cfg)[0] || '').trim();
    if (name) return { type: 'function', name };
    return 'required';
  }
  if (mode === 'AUTO') return 'auto';
  return undefined;
}

module.exports = {
  collectGeminiFunctionDeclarations,
  createGeminiFunctionDeclaration,
  createGeminiToolConfig,
  mapAnthropicToolChoiceToGemini,
  mapAnthropicToolsToGemini,
  mapGeminiToolConfigToAnthropic,
  mapGeminiToolConfigToOpenAI,
  mapGeminiToolConfigToOpenAIResponses,
  mapGeminiToolsToAnthropic,
  mapGeminiToolsToOpenAI,
  mapGeminiToolsToOpenAIResponses,
  mapOpenAIToolChoiceToGemini,
  mapOpenAIToolsToGemini,
  wrapGeminiFunctionDeclarations,
  __private: {
    mapToolName,
    readGeminiAllowedFunctionNames,
    readGeminiFunctionCallingConfig,
    readGeminiToolSchema
  }
};
