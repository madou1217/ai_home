const test = require('node:test');
const assert = require('node:assert/strict');
const {
  fetchCodeAssistAnthropicMessage,
  fetchCodeAssistAnthropicMessageStream,
  anthropicMessageToCanonicalEvents,
  __private
} = require('../lib/server/code-assist-anthropic-adapter');
const {
  resolveCodeAssistAdaptiveThinkingConfig,
  resolveCodeAssistProviderStrategy
} = require('../lib/server/code-assist-provider-strategy');
const {
  createRequiredToolLookup
} = require('../lib/protocol/tool-call-validation');
const {
  createToolSchemaLookup
} = require('../lib/protocol/tool-call-normalization');
const { resolveDirectProviderProtocolRoute } = require('../lib/server/provider-protocol-routing');
const { createCanonicalRenderer } = require('../lib/server/protocol-stream-pipeline');

const CLAUDE_GOAL_EVALUATOR_PROMPT = [
  'INSTRUCTIONS: Evaluate the condition solely based on the conversation transcript above. Think carefully. Then output JSON in one of these three formats:',
  '1. {"ok": true, "reason": "..."}',
  '2. {"ok": false, "reason": "..."}',
  '3. {"ok": false, "impossible": true, "reason": "..."} (only if the goal is genuinely unachievable)',
  '',
  'Make sure you output valid JSON. Do not output anything else.'
].join('\n');

test('Code Assist Anthropic adapter maps Claude tools and tool results without OpenAI chat shape', async (t) => {
  let generateBody = null;
  let seenHeaders = null;
  const diagnostics = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-test' })
      };
    }
    if (safeUrl.includes(':streamGenerateContent')) {
      seenHeaders = init && init.headers;
      generateBody = JSON.parse(String(init && init.body || '{}'));
      const chunk = [
        'data: ',
        JSON.stringify({
          traceId: 'trace-agy-1',
          modelVersion: 'gemini-2.5-pro',
          candidates: [{
            finishReason: 'UNEXPECTED_TOOL_CALL',
            content: {
              parts: [{
                functionCall: {
                  id: 'toolu_next_1',
                  name: 'Bash',
                  args: { command: 'pwd' }
                }
              }]
            }
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 }
        }),
        '\n\n'
      ].join('');
      return {
        ok: true,
        status: 200,
        body: {
          async *[Symbol.asyncIterator]() {
            yield chunk;
          }
        }
      };
    }
    if (safeUrl.includes(':generateContent')) {
      generateBody = JSON.parse(String(init && init.body || '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: 'trace-agy-1',
          modelVersion: 'gemini-2.5-pro',
          candidates: [{
            finishReason: 'UNEXPECTED_TOOL_CALL',
            content: {
              parts: [{
                functionCall: {
                  id: 'toolu_next_1',
                  name: 'Bash',
                  args: { command: 'pwd' }
                }
              }]
            }
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const result = await fetchCodeAssistAnthropicMessage(
    {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      providerProtocolRoute: resolveDirectProviderProtocolRoute('anthropic_messages', 'agy'),
      sourceClientProtocol: 'openai_responses',
      protocolAdapterPath: ['codex2claudeAdapter'],
      appendGeminiCodeAssistDiagnostic: (item) => diagnostics.push(item)
    },
    {
      id: 'agy-1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'claude-4-6-thinking',
      max_tokens: 256,
      system: [{ type: 'text', text: '你是代码助手' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: '检查项目' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '我先读取文件。' },
            { type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { file_path: 'package.json' } },
            { type: 'tool_use', id: 'toolu_bash_1', name: 'Bash', input: { command: 'pwd' } }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_read_1', content: 'package content' },
            { type: 'tool_result', tool_use_id: 'toolu_bash_1', content: 'cwd output' }
          ]
        }
      ],
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
        },
        {
          name: 'Bash',
          description: 'Run a shell command',
          input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
        }
      ],
      tool_choice: { type: 'auto' }
    },
    800
  );

  assert.ok(generateBody);
  assert.equal(generateBody.model, 'claude-4-6-thinking');
  assert.match(generateBody.requestId, /^agent\/[0-9]+\/[0-9a-f]{8}$/);
  assert.equal(generateBody.requestType, 'agent');
  assert.equal(generateBody.userAgent, 'antigravity');
  assert.deepEqual(generateBody.enabledCreditTypes, ['GOOGLE_ONE_AI']);
  assert.equal(generateBody.user_prompt_id, undefined);
  assert.equal(generateBody.request.systemInstruction.parts[0].text, '你是代码助手');
  assert.equal(typeof generateBody.request.sessionId, 'string');
  assert.equal(generateBody.request.session_id, undefined);
  assert.equal(generateBody.request.generationConfig.maxOutputTokens, 256);
  assert.equal(generateBody.request.tools[0].functionDeclarations[0].name, 'Read');
  assert.ok(generateBody.request.tools[0].functionDeclarations[0].parameters);
  assert.equal(generateBody.request.tools[0].functionDeclarations[0].parametersJsonSchema, undefined);
  assert.equal(generateBody.request.tools[0].functionDeclarations[1].name, 'Bash');
  assert.ok(generateBody.request.tools[0].functionDeclarations[1].parameters);
  assert.equal(generateBody.request.tools[0].functionDeclarations[1].parametersJsonSchema, undefined);

  const assistantParts = generateBody.request.contents[1].parts;
  assert.equal(assistantParts[0].text, '我先读取文件。');
  assert.equal(assistantParts[1].functionCall.id, 'toolu_read_1');
  assert.equal(assistantParts[1].functionCall.name, 'Read');
  assert.equal(assistantParts[1].thoughtSignature, 'skip_thought_signature_validator');
  assert.equal(assistantParts[2].functionCall.id, 'toolu_bash_1');
  assert.equal(assistantParts[2].functionCall.name, 'Bash');

  const resultParts = generateBody.request.contents[2].parts;
  assert.equal(resultParts[0].functionResponse.id, 'toolu_read_1');
  assert.equal(resultParts[0].functionResponse.name, 'Read');
  assert.equal(resultParts[0].functionResponse.response.result, 'package content');
  assert.equal(resultParts[1].functionResponse.id, 'toolu_bash_1');
  assert.equal(resultParts[1].functionResponse.name, 'Bash');
  assert.equal(resultParts[1].functionResponse.response.result, 'cwd output');

  assert.ok(seenHeaders);
  assert.match(seenHeaders['user-agent'], /^Antigravity\//);
  assert.equal(seenHeaders['x-client-name'], 'antigravity');
  assert.match(seenHeaders['x-client-version'], /^\d+\.\d+\.\d+$/);
  assert.equal(seenHeaders['x-goog-user-project'], undefined);
  assert.equal(seenHeaders['anthropic-beta'], 'claude-code-20250219');

  assert.equal(result.model, 'claude-4-6-thinking');
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.content, [{
    type: 'tool_use',
    id: 'toolu_next_1',
    name: 'Bash',
    input: { command: 'pwd' }
  }]);
  assert.equal(diagnostics[0].requestProtocol, 'anthropic_messages_direct');
  assert.equal(diagnostics[0].clientProtocol, 'anthropic_messages');
  assert.equal(diagnostics[0].sourceClientProtocol, 'openai_responses');
  assert.deepEqual(diagnostics[0].protocolAdapterPath, ['codex2claudeAdapter']);
  assert.equal(diagnostics[0].requestEnvelope, 'antigravity_agent');
  assert.equal(diagnostics[0].requestType, 'agent');
  assert.equal(diagnostics[0].creditTypesIncluded, true);
  assert.equal(diagnostics[0].creditTypesField, 'enabledCreditTypes');
  assert.equal(diagnostics[0].creditTypesForced, true);
  assert.equal(diagnostics[0].forceStreamForBuffered, true);
  assert.equal(diagnostics[0].method, 'streamGenerateContent');
  assert.equal(diagnostics[0].clientName, 'antigravity');
  assert.equal(diagnostics[0].clientVersion, seenHeaders['x-client-version']);
  assert.equal(diagnostics[0].projectHeader, false);
  assert.equal(diagnostics[0].anthropicBetaHeader, 'claude-code-20250219');
  assert.equal(diagnostics[0].upstreamProtocol, 'gemini_code_assist_generate_content');
  assert.equal(diagnostics[0].requestAdapter, 'claude2agyAdapter');
  assert.equal(diagnostics[0].responseAdapter, 'agy2claudeAdapter');
  const responseDiagnostic = diagnostics.find((item) => Array.isArray(item.responseToolCalls));
  assert.ok(responseDiagnostic);
  assert.deepEqual(responseDiagnostic.responseToolCalls, [{
    candidateIndex: 0,
    id: 'toolu_next_1',
    name: 'Bash',
    argumentLength: 17,
    argKeys: ['command'],
    emptyArgs: false
  }]);
});

test('Code Assist Anthropic adapter resolves missing model from live descriptor catalog', async (t) => {
  let generateBody = null;
  const seenUrls = [];
  t.mock.method(global, 'fetch', async (url, init = {}) => {
    const safeUrl = String(url || '');
    seenUrls.push(safeUrl);
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-default' })
      };
    }
    if (safeUrl.includes(':fetchAvailableModels')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            { model: 'catalog-default', wireModelId: 'wire-default' }
          ]
        })
      };
    }
    if (safeUrl.includes(':generateContent')) {
      generateBody = JSON.parse(String(init && init.body || '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: 'trace-default',
          modelVersion: 'wire-default',
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text: 'OK' }] }
          }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const account = {
    id: 'agy-1',
    provider: 'agy',
    authType: 'oauth-personal',
    accessToken: 'token-1'
  };

  const result = await fetchCodeAssistAnthropicMessage(
    {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      providerProtocolRoute: resolveDirectProviderProtocolRoute('anthropic_messages', 'agy')
    },
    account,
    {
      max_tokens: 128,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    },
    500
  );

  assert.equal(seenUrls.some((url) => url.includes(':fetchAvailableModels')), true);
  assert.equal(generateBody.model, 'wire-default');
  assert.equal(result.model, 'catalog-default');
  assert.deepEqual(account.availableModels, ['catalog-default']);
});

test('Code Assist Anthropic adapter sends AGY direct requests without project header', async (t) => {
  const streamHeaders = [];
  const diagnostics = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-test' })
      };
    }
    if (safeUrl.includes(':streamGenerateContent')) {
      streamHeaders.push(init && init.headers);
      return {
        ok: true,
        status: 200,
        body: {
          async *[Symbol.asyncIterator]() {
            yield [
              'data: ',
              JSON.stringify({
                candidates: [{
                  finishReason: 'STOP',
                  content: { parts: [{ text: 'ok' }] }
                }],
                usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
              }),
              '\n\n'
            ].join('');
          }
        }
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const result = await fetchCodeAssistAnthropicMessage(
    {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      providerProtocolRoute: resolveDirectProviderProtocolRoute('anthropic_messages', 'agy'),
      appendGeminiCodeAssistDiagnostic: (item) => diagnostics.push(item)
    },
    {
      id: 'agy-1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'claude-4-6-thinking',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }]
    },
    800
  );

  assert.equal(streamHeaders.length, 1);
  assert.equal(streamHeaders[0]['x-goog-user-project'], undefined);
  assert.equal(result.stop_reason, 'end_turn');
  assert.deepEqual(result.content, [{ type: 'text', text: 'ok' }]);
  assert.equal(diagnostics.some((item) => item.projectHeaderRetry === true), false);
});

test('Code Assist Anthropic adapter sanitizes and restores client tool names consistently', async (t) => {
  let generateBody = null;
  const diagnostics = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-test' })
      };
    }
    if (safeUrl.includes(':generateContent')) {
      generateBody = JSON.parse(String(init && init.body || '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: 'trace-agy-sanitized',
          modelVersion: 'gemini-2.5-pro',
          candidates: [{
            finishReason: 'STOP',
            content: {
              parts: [{
                functionCall: {
                  id: 'toolu_next_sanitized',
                  name: 'mcp_server_read',
                  args: { file_path: 'package.json' }
                }
              }]
            }
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const result = await fetchCodeAssistAnthropicMessage(
    {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      appendGeminiCodeAssistDiagnostic: (item) => diagnostics.push(item)
    },
    {
      id: 'agy-1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'claude-4-6-thinking',
      max_tokens: 256,
      messages: [
        { role: 'user', content: [{ type: 'text', text: '读取文件' }] },
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'toolu_mcp_1',
            name: 'mcp/server/read',
            input: { file_path: 'package.json' }
          }]
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_mcp_1', content: 'package content' }]
        }
      ],
      tools: [
        {
          name: 'mcp/server/read',
          description: 'Read a file through MCP',
          input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
        },
        {
          name: '1bad name',
          description: 'Starts with a digit',
          input_schema: { type: 'object', properties: {} }
        },
        {
          name: 'read/file',
          description: 'Collision candidate A',
          input_schema: { type: 'object', properties: {} }
        },
        {
          name: 'read@file',
          description: 'Collision candidate B',
          input_schema: { type: 'object', properties: {} }
        }
      ],
      tool_choice: { type: 'tool', name: 'mcp/server/read' }
    },
    800
  );

  assert.ok(generateBody);
  const declarations = generateBody.request.tools[0].functionDeclarations;
  assert.deepEqual(
    declarations.map((declaration) => declaration.name),
    ['mcp_server_read', '_1bad_name', 'read_file', 'read_file_2']
  );
  assert.deepEqual(
    generateBody.request.toolConfig.functionCallingConfig.allowedFunctionNames,
    ['mcp_server_read']
  );

  const assistantParts = generateBody.request.contents[1].parts;
  assert.equal(assistantParts[0].functionCall.id, 'toolu_mcp_1');
  assert.equal(assistantParts[0].functionCall.name, 'mcp_server_read');
  assert.equal(assistantParts[0].thoughtSignature, 'skip_thought_signature_validator');

  const resultParts = generateBody.request.contents[2].parts;
  assert.equal(resultParts[0].functionResponse.id, 'toolu_mcp_1');
  assert.equal(resultParts[0].functionResponse.name, 'mcp_server_read');
  assert.equal(resultParts[0].functionResponse.response.result, 'package content');

  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.content, [{
    type: 'tool_use',
    id: 'toolu_next_sanitized',
    name: 'mcp/server/read',
    input: { file_path: 'package.json' }
  }]);

  assert.equal(diagnostics[0].requestSummary.toolUseInputs[0].name, 'mcp/server/read');
  assert.equal(diagnostics[0].requestSummary.toolUseInputs[0].upstreamName, 'mcp_server_read');
  assert.deepEqual(diagnostics[0].requestSummary.toolUseInputs[0].missingRequired, []);
});

test('Code Assist Anthropic adapter handles generic no-argument tools without Read-specific assumptions', async (t) => {
  let generateBody = null;
  t.mock.method(global, 'fetch', async (url, init) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-test' })
      };
    }
    if (safeUrl.includes(':generateContent')) {
      generateBody = JSON.parse(String(init && init.body || '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: 'trace-agy-noarg',
          modelVersion: 'gemini-2.5-pro',
          candidates: [{
            finishReason: 'STOP',
            content: {
              parts: [{
                functionCall: {
                  id: 'toolu_todo_read',
                  name: 'TodoRead',
                  args: {}
                }
              }]
            }
          }],
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1, totalTokenCount: 9 }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const result = await fetchCodeAssistAnthropicMessage(
    {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal'
    },
    {
      id: 'agy-1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'claude-4-6-thinking',
      max_tokens: 256,
      messages: [{ role: 'user', content: [{ type: 'text', text: '列出 todos' }] }],
      tools: [{
        name: 'TodoRead',
        description: 'Read todos',
        input_schema: { type: 'object', properties: {} }
      }]
    },
    800
  );

  assert.ok(generateBody);
  const declaration = generateBody.request.tools[0].functionDeclarations[0];
  assert.equal(declaration.name, 'TodoRead');
  assert.equal(declaration.parameters.type, 'object');
  assert.equal(declaration.parameters.required, undefined);
  assert.equal(declaration.parametersJsonSchema, undefined);
  assert.deepEqual(result.content, [{
    type: 'tool_use',
    id: 'toolu_todo_read',
    name: 'TodoRead',
    input: {}
  }]);
  assert.equal(result.stop_reason, 'tool_use');
});

test('Code Assist Anthropic renderer normalizes tool aliases before Claude tool_use output', () => {
  const declarations = [
    {
      name: 'Write',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['file_path', 'content'],
        additionalProperties: false
      }
    },
    {
      name: 'Edit',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' }
        },
        required: ['file_path', 'old_string', 'new_string'],
        additionalProperties: false
      }
    },
    {
      name: 'Read',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          offset: { type: 'number' },
          limit: { type: 'number' }
        },
        required: ['file_path'],
        additionalProperties: false
      }
    },
    {
      name: 'Agent',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          prompt: { type: 'string' },
          subagent_type: { type: 'string' }
        },
        required: ['description', 'prompt'],
        additionalProperties: false
      }
    }
  ];
  const protocolDiagnostics = [];
  const message = __private.renderCodeAssistAnthropicMessage({
    response: {
      responseId: 'resp_write_alias',
      candidates: [{
        finishReason: 'UNEXPECTED_TOOL_CALL',
        content: {
          parts: [
            {
              functionCall: {
                id: 'toolu_write_alias',
                name: 'Write',
                args: {
                  file_path: 'tmp/remote-ssh-development-design.md',
                  write_content: 'secret design body'
                }
              }
            },
            {
              functionCall: {
                id: 'toolu_write_file_content_alias',
                name: 'Write',
                args: {
                  file_path: 'prototypes/p11-hifi-desktop.html',
                  file_content: '<html>secret prototype</html>'
                }
              }
            },
            {
              functionCall: {
                id: 'toolu_edit_replace_alias',
                name: 'Edit',
                args: {
                  file_path: 'lib/cli/services/pty/runtime.js',
                  old_string: 'before',
                  replace_string: 'after',
                  replace_all: false
                }
              }
            },
            {
              functionCall: {
                id: 'toolu_read_lines_required_alias',
                name: 'Read',
                args: {
                  file_path: 'lib/server/code-assist-anthropic-adapter.js',
                  lines_required: 80
                }
              }
            },
            {
              functionCall: {
                id: 'toolu_agent_message_alias',
                name: 'Agent',
                args: {
                  subagent_type: 'Explore',
                  args: [],
                  message: 'Please search the web/src folder for chat session persistence issues.'
                }
              }
            }
          ]
        }
      }]
    }
  }, 'claude-4-6-thinking', __private.createToolNameCodec([{ name: 'Write' }, { name: 'Edit' }, { name: 'Read' }, { name: 'Agent' }]), {
    requiredByName: createRequiredToolLookup(declarations, 'parametersJsonSchema'),
    schemaByName: createToolSchemaLookup(declarations, 'parametersJsonSchema'),
    toolProtocolDiagnosticContext: {
      requestId: 'req-write-alias',
      provider: 'agy',
      accountId: 'agy-1',
      model: 'claude-4-6-thinking',
      sourceProtocol: 'gemini_code_assist_generate_content',
      targetProtocol: 'anthropic_messages',
      adapterPath: ['agy2claudeAdapter'],
      appendToolProtocolDiagnostic: (entry) => protocolDiagnostics.push(entry),
      writeToolProtocolDiagnosticFile: false
    }
  });

  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(message.content, [
    {
      type: 'tool_use',
      id: 'toolu_write_alias',
      name: 'Write',
      input: {
        file_path: 'tmp/remote-ssh-development-design.md',
        content: 'secret design body'
      }
    },
    {
      type: 'tool_use',
      id: 'toolu_write_file_content_alias',
      name: 'Write',
      input: {
        file_path: 'prototypes/p11-hifi-desktop.html',
        content: '<html>secret prototype</html>'
      }
    },
    {
      type: 'tool_use',
      id: 'toolu_edit_replace_alias',
      name: 'Edit',
      input: {
        file_path: 'lib/cli/services/pty/runtime.js',
        old_string: 'before',
        new_string: 'after',
        replace_all: false
      }
    },
    {
      type: 'tool_use',
      id: 'toolu_read_lines_required_alias',
      name: 'Read',
      input: {
        file_path: 'lib/server/code-assist-anthropic-adapter.js',
        limit: 80
      }
    },
    {
      type: 'tool_use',
      id: 'toolu_agent_message_alias',
      name: 'Agent',
      input: {
        subagent_type: 'Explore',
        prompt: 'Please search the web/src folder for chat session persistence issues.',
        description: 'Please search the web/src folder for chat session persistence issues.'
      }
    }
  ]);
  assert.equal(protocolDiagnostics.length, 5);
  assert.equal(protocolDiagnostics[0].action, 'normalized');
  assert.equal(protocolDiagnostics[0].reason, 'alias_mapped');
  assert.deepEqual(protocolDiagnostics[0].argKeys, ['file_path', 'write_content']);
  assert.deepEqual(protocolDiagnostics[0].normalizedKeys, ['content']);
  assert.deepEqual(protocolDiagnostics[0].removedKeys, ['write_content']);
  assert.equal(protocolDiagnostics[0].rawArgsPreview.includes('secret design body'), false);
  assert.deepEqual(protocolDiagnostics[1].argKeys, ['file_path', 'file_content']);
  assert.deepEqual(protocolDiagnostics[1].normalizedKeys, ['content']);
  assert.deepEqual(protocolDiagnostics[1].removedKeys, ['file_content']);
  assert.equal(protocolDiagnostics[1].rawArgsPreview.includes('secret prototype'), false);
  assert.deepEqual(protocolDiagnostics[2].argKeys, ['file_path', 'old_string', 'replace_string', 'replace_all']);
  assert.deepEqual(protocolDiagnostics[2].normalizedKeys, ['new_string']);
  assert.deepEqual(protocolDiagnostics[2].removedKeys, ['replace_string']);
  assert.deepEqual(protocolDiagnostics[3].argKeys, ['file_path', 'lines_required']);
  assert.deepEqual(protocolDiagnostics[3].normalizedKeys, ['limit']);
  assert.deepEqual(protocolDiagnostics[3].removedKeys, ['lines_required']);
  assert.deepEqual(protocolDiagnostics[4].argKeys, ['subagent_type', 'args', 'message']);
  assert.deepEqual(protocolDiagnostics[4].normalizedKeys, ['prompt', 'description']);
  assert.deepEqual(protocolDiagnostics[4].removedKeys, ['message', 'args']);
});

test('Code Assist Anthropic renderer derives empty TaskCreate input from adjacent thinking', () => {
  const declarations = [{
    name: 'TaskCreate',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        description: { type: 'string' },
        activeForm: { type: 'string' }
      },
      required: ['subject', 'description'],
      additionalProperties: false
    }
  }];
  const protocolDiagnostics = [];
  const message = __private.renderCodeAssistAnthropicMessage({
    response: {
      responseId: 'resp_task_create_context',
      candidates: [{
        finishReason: 'UNEXPECTED_TOOL_CALL',
        content: {
          parts: [
            {
              thought: true,
              text: '**Developing SSH Host Persistence**\n\nPersist backend SSH host configurations and construct the API routing layer.'
            },
            {
              functionCall: {
                id: 'toolu_task_create_context',
                name: 'TaskCreate',
                args: {}
              }
            }
          ]
        }
      }]
    }
  }, 'claude-4-6-thinking', __private.createToolNameCodec([{ name: 'TaskCreate' }]), {
    requiredByName: createRequiredToolLookup(declarations, 'parametersJsonSchema'),
    schemaByName: createToolSchemaLookup(declarations, 'parametersJsonSchema'),
    toolProtocolDiagnosticContext: {
      requestId: 'req-task-create-context',
      provider: 'agy',
      accountId: 'agy-1',
      model: 'claude-4-6-thinking',
      sourceProtocol: 'gemini_code_assist_generate_content',
      targetProtocol: 'anthropic_messages',
      adapterPath: ['agy2claudeAdapter'],
      appendToolProtocolDiagnostic: (entry) => protocolDiagnostics.push(entry),
      writeToolProtocolDiagnosticFile: false
    }
  });

  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(message.content, [
    {
      type: 'thinking',
      thinking: '**Developing SSH Host Persistence**\n\nPersist backend SSH host configurations and construct the API routing layer.'
    },
    {
      type: 'tool_use',
      id: 'toolu_task_create_context',
      name: 'TaskCreate',
      input: {
        subject: 'Developing SSH Host Persistence',
        description: 'Persist backend SSH host configurations and construct the API routing layer.'
      }
    }
  ]);
  assert.equal(protocolDiagnostics.length, 1);
  assert.equal(protocolDiagnostics[0].action, 'normalized');
  assert.equal(protocolDiagnostics[0].reason, 'context_derived');
  assert.deepEqual(protocolDiagnostics[0].normalizedKeys, ['subject', 'description']);
});

test('Code Assist Anthropic renderer rejects non-inferable missing tool input', () => {
  const declarations = [{
    name: 'Bash',
    parametersJsonSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false
    }
  }];
  const protocolDiagnostics = [];
  const message = __private.renderCodeAssistAnthropicMessage({
    response: {
      responseId: 'resp_bash_missing',
      candidates: [{
        finishReason: 'UNEXPECTED_TOOL_CALL',
        content: {
          parts: [{
            functionCall: {
              id: 'toolu_bash_missing',
              name: 'Bash',
              args: {}
            }
          }]
        }
      }]
    }
  }, 'claude-4-6-thinking', __private.createToolNameCodec([{ name: 'Bash' }]), {
    requiredByName: createRequiredToolLookup(declarations, 'parametersJsonSchema'),
    schemaByName: createToolSchemaLookup(declarations, 'parametersJsonSchema'),
    toolProtocolDiagnosticContext: {
      requestId: 'req-bash-missing',
      provider: 'agy',
      accountId: 'agy-1',
      model: 'claude-4-6-thinking',
      sourceProtocol: 'gemini_code_assist_generate_content',
      targetProtocol: 'anthropic_messages',
      adapterPath: ['agy2claudeAdapter'],
      appendToolProtocolDiagnostic: (entry) => protocolDiagnostics.push(entry),
      writeToolProtocolDiagnosticFile: false
    }
  });

  assert.equal(message.stop_reason, 'end_turn');
  assert.deepEqual(message.content, [{
    type: 'text',
    text: 'Upstream returned invalid tool call input; suppressed execution for: Bash missing required input: command'
  }]);
  assert.equal(protocolDiagnostics.length, 1);
  assert.equal(protocolDiagnostics[0].action, 'rejected');
  assert.equal(protocolDiagnostics[0].reason, 'missing_required');
  assert.deepEqual(protocolDiagnostics[0].argKeys, []);
  assert.deepEqual(protocolDiagnostics[0].requiredKeys, ['command']);
  assert.deepEqual(protocolDiagnostics[0].missingKeys, ['command']);
});

test('Code Assist Anthropic adapter logs malformed non-stream tool arguments without special-casing tools', async (t) => {
  const diagnostics = [];
  t.mock.method(global, 'fetch', async (url) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-test' })
      };
    }
    if (safeUrl.includes(':generateContent')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: 'trace-agy-bad-args',
          modelVersion: 'gemini-2.5-pro',
          candidates: [{
            finishReason: 'UNEXPECTED_TOOL_CALL',
            content: {
              parts: [{
                functionCall: {
                  id: 'toolu_lookup_bad_args',
                  name: 'Lookup',
                  args: '{"query":'
                }
              }]
            }
          }],
          usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1, totalTokenCount: 9 }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const result = await fetchCodeAssistAnthropicMessage(
    {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      appendGeminiCodeAssistDiagnostic: (item) => diagnostics.push(item)
    },
    {
      id: 'agy-1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'claude-4-6-thinking',
      max_tokens: 256,
      messages: [{ role: 'user', content: [{ type: 'text', text: '查一下' }] }],
      tools: [{
        name: 'Lookup',
        description: 'Lookup data',
        input_schema: { type: 'object', properties: { query: { type: 'string' } } }
      }]
    },
    800
  );

  assert.deepEqual(result.content, [{
    type: 'text',
    text: 'Upstream returned invalid tool call input; suppressed execution for: Lookup (invalid_json_object)'
  }]);
  const responseDiagnostic = diagnostics.find((item) => Array.isArray(item.responseToolCallArgumentDiagnostics));
  assert.ok(responseDiagnostic);
  assert.deepEqual(responseDiagnostic.responseToolCallArgumentDiagnostics, [{
    candidateIndex: 0,
    id: 'toolu_lookup_bad_args',
    name: 'Lookup',
    argsKind: 'string',
    argumentLength: 9,
    reason: 'invalid_json_object'
  }]);
  assert.deepEqual(responseDiagnostic.responseToolCallValidationDiagnostics, [{
    candidateIndex: 0,
    type: 'tool_call_invalid_input',
    id: 'toolu_lookup_bad_args',
    name: 'Lookup',
    argsKind: 'string',
    argumentLength: 9,
    reason: 'invalid_json_object'
  }]);
});

test('Code Assist Anthropic adapter flattens text tool_result arrays and nests images', async (t) => {
  let generateBody = null;
  t.mock.method(global, 'fetch', async (url, init) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-test' })
      };
    }
    if (safeUrl.includes(':generateContent')) {
      generateBody = JSON.parse(String(init && init.body || '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          traceId: 'trace-tool-result-array',
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text: 'done' }] }
          }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 }
        })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  await fetchCodeAssistAnthropicMessage(
    {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal'
    },
    {
      id: 'agy-1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'claude-4-6-thinking',
      messages: [
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'Read-123-456',
            name: 'Read',
            input: { file_path: '/tmp/a.png' }
          }]
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'Read-123-456',
            content: [
              { type: 'text', text: 'File content here' },
              { type: 'text', text: 'Second text block' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'iVBORw0KGgoAAAANSUhEUg=='
                }
              }
            ]
          }]
        }
      ],
      tools: [{
        name: 'Read',
        description: 'Read file',
        input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
      }]
    },
    800
  );

  const functionResponse = generateBody.request.contents[1].parts[0].functionResponse;
  assert.equal(functionResponse.id, 'Read-123-456');
  assert.equal(functionResponse.name, 'Read');
  assert.equal(functionResponse.response.result, 'File content here\nSecond text block');
  assert.deepEqual(functionResponse.parts, [{
    inlineData: {
      mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUg=='
    }
  }]);
  assert.equal(generateBody.request.contents[1].parts.length, 1);
});

test('Code Assist Anthropic adapter keeps model function calls last to preserve Claude tool result adjacency', () => {
  const normalized = __private.normalizeAnthropicMessagesForCodeAssist(
    [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me inspect that.' },
          {
            type: 'tool_use',
            id: 'call_read_1',
            name: 'Read',
            input: { file_path: 'package.json' }
          },
          { type: 'text', text: 'Reading the file now.' }
        ]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_read_1', content: 'package content' }]
      }
    ],
    '',
    resolveCodeAssistProviderStrategy('agy'),
    __private.createToolNameCodec([{ name: 'Read' }])
  );

  const modelParts = normalized.contents[0].parts;
  assert.equal(modelParts[0].text, 'Let me inspect that.');
  assert.equal(modelParts[1].text, 'Reading the file now.');
  assert.equal(modelParts[2].functionCall.name, 'Read');
  assert.equal(modelParts[2].functionCall.id, 'call_read_1');
  assert.deepEqual(modelParts[2].functionCall.args, { file_path: 'package.json' });

  const resultPart = normalized.contents[1].parts[0].functionResponse;
  assert.equal(resultPart.id, 'call_read_1');
  assert.equal(resultPart.name, 'Read');
  assert.equal(resultPart.response.result, 'package content');
});

test('Code Assist Anthropic adapter drops trailing unanswered function calls generically', () => {
  const normalized = __private.normalizeAnthropicMessagesForCodeAssist(
    [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Fetch status' }]
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will call the tool.' },
          {
            type: 'tool_use',
            id: 'toolu_custom_fetch',
            name: 'CustomFetch',
            input: { url: 'https://example.test' }
          }
        ]
      }
    ],
    '',
    resolveCodeAssistProviderStrategy('agy'),
    __private.createToolNameCodec([{ name: 'CustomFetch' }]),
    { dropTrailingUnansweredFunctionCalls: true }
  );

  assert.equal(normalized.droppedTrailingUnansweredFunctionCallTurn, 1);
  assert.equal(normalized.contents.length, 2);
  assert.equal(normalized.contents[0].role, 'user');
  assert.equal(normalized.contents[1].role, 'model');
  assert.deepEqual(normalized.contents[1].parts, [{ text: 'I will call the tool.' }]);
  assert.equal(
    normalized.contents.flatMap((content) => content.parts).some((part) => part.functionCall),
    false
  );
});

test('Code Assist Anthropic adapter keeps missing or null tool_result content valid', () => {
  const toolNameCodec = __private.createToolNameCodec([{ name: 'MyTool' }]);
  const normalized = __private.normalizeAnthropicMessagesForCodeAssist(
    [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'MyTool-123-456',
            name: 'MyTool',
            input: { key: 'value' }
          },
          {
            type: 'tool_use',
            id: 'MyTool-123-457',
            name: 'MyTool',
            input: { key: 'other' }
          }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'MyTool-123-456' },
          { type: 'tool_result', tool_use_id: 'MyTool-123-457', content: null }
        ]
      }
    ],
    '',
    resolveCodeAssistProviderStrategy('agy'),
    toolNameCodec
  );

  const responses = normalized.contents[1].parts.map((part) => part.functionResponse);
  assert.equal(responses.length, 2);
  assert.deepEqual(responses.map((response) => response.response), [
    { result: '' },
    { result: '' }
  ]);
  assert.equal(JSON.stringify(normalized).includes('undefined'), false);
});

test('Code Assist Anthropic adapter derives functionResponse names from tool_use ids without Read-specific logic', () => {
  const normalized = __private.normalizeAnthropicMessagesForCodeAssist(
    [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'get_weather-call-123',
            name: 'get_weather',
            input: { city: 'Shanghai' }
          },
          {
            type: 'tool_use',
            id: 'CustomTool-987-654',
            name: 'CustomTool',
            input: { value: true }
          }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'get_weather-call-123', content: '22C sunny' },
          { type: 'tool_result', tool_use_id: 'CustomTool-987-654', content: 'custom result' }
        ]
      }
    ],
    '',
    resolveCodeAssistProviderStrategy('agy'),
    __private.createToolNameCodec([])
  );

  const responses = normalized.contents[1].parts.map((part) => part.functionResponse);
  assert.equal(responses[0].id, 'get_weather-call-123');
  assert.equal(responses[0].name, 'get_weather');
  assert.equal(responses[0].response.result, '22C sunny');
  assert.equal(responses[1].id, 'CustomTool-987-654');
  assert.equal(responses[1].name, 'CustomTool');
  assert.equal(responses[1].response.result, 'custom result');
});

test('Code Assist Anthropic adapter only emits functionResponse for adjacent tool results', () => {
  const normalized = __private.normalizeAnthropicMessagesForCodeAssist(
    [
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call_lookup_1',
          name: 'Lookup',
          input: { query: 'codex' }
        }]
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'non-tool interjection' }]
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_lookup_1',
          content: 'late result'
        }]
      }
    ],
    '',
    resolveCodeAssistProviderStrategy('agy'),
    __private.createToolNameCodec([{ name: 'Lookup' }])
  );

  assert.equal(normalized.droppedUnansweredFunctionCallCount, 1);
  assert.equal(normalized.droppedUnansweredToolUseCount, 1);
  assert.equal(normalized.orphanToolResultCount, 1);
  assert.deepEqual(normalized.contents.map((content) => content.role), ['user', 'user']);
  assert.equal(
    normalized.contents.flatMap((content) => content.parts).some((part) => part.functionCall || part.functionResponse),
    false
  );
  assert.equal(normalized.contents[1].parts[0].text, 'Tool result (call_lookup_1):\nlate result');
});

test('Code Assist Anthropic adapter includes sanitized tool history stats in request diagnostics', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-test' })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const context = await __private.buildCodeAssistAnthropicGenerateContext(
    {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal'
    },
    {
      id: 'agy-1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'claude-4-6-thinking',
      messages: [
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'call_custom_1',
            name: 'CustomTool',
            input: { value: 1 }
          }]
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'interruption before result' }]
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'call_custom_1',
            content: 'late result'
          }]
        }
      ],
      tools: [{
        name: 'CustomTool',
        description: 'Custom tool',
        input_schema: { type: 'object', properties: { value: { type: 'number' } } }
      }]
    },
    800
  );

  assert.equal(context.diagnostic.requestSummary.droppedUnansweredToolUseCount, 1);
  assert.equal(context.diagnostic.requestSummary.droppedUnansweredFunctionCallCount, 1);
  assert.equal(context.diagnostic.requestSummary.orphanToolResultCount, 1);
  assert.deepEqual(context.payload.request.contents.map((content) => content.role), ['user', 'user']);
  assert.equal(context.payload.request.contents[1].parts[0].text, 'Tool result (call_custom_1):\nlate result');
  assert.equal(
    context.payload.request.contents.flatMap((content) => content.parts).some((part) => part.functionCall || part.functionResponse),
    false
  );
});

test('Code Assist Anthropic renderer emits reversible Claude-safe tool_use ids', () => {
  const message = __private.renderCodeAssistAnthropicMessage({
    response: {
      responseId: 'resp_invalid_tool_id',
      candidates: [{
        finishReason: 'UNEXPECTED_TOOL_CALL',
        content: {
          parts: [
            {
              functionCall: {
                id: 'tool/use.id:1',
                name: 'Read',
                args: { file_path: 'package.json' }
              }
            },
            {
              functionCall: {
                id: 'tool:use.id/1',
                name: 'Bash',
                args: { command: 'pwd' }
              }
            }
          ]
        }
      }]
    }
  }, 'claude-4-6-thinking');

  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(message.content.map((part) => ({ ...part, id: '<id>' })), [{
    type: 'tool_use',
    id: '<id>',
    name: 'Read',
    input: { file_path: 'package.json' }
  }, {
    type: 'tool_use',
    id: '<id>',
    name: 'Bash',
    input: { command: 'pwd' }
  }]);
  assert.match(message.content[0].id, /^toolu_aih_1_[a-zA-Z0-9_-]+$/);
  assert.match(message.content[1].id, /^toolu_aih_2_[a-zA-Z0-9_-]+$/);
  assert.notEqual(message.content[0].id, message.content[1].id);
  assert.equal(__private.decodeAnthropicToolUseId(message.content[0].id), 'tool/use.id:1');
  assert.equal(__private.decodeAnthropicToolUseId(message.content[1].id), 'tool:use.id/1');

  const events = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      finishReason: 'UNEXPECTED_TOOL_CALL',
      content: {
        parts: [
          {
            functionCall: {
              id: 'tool/use.id:2',
              name: 'Read',
              args: { file_path: 'README.md' }
            }
          },
          {
            functionCall: {
              id: 'tool:use.id/2',
              name: 'Bash',
              args: { command: 'pwd' }
            }
          }
        ]
      }
    }]
  }, { nextToolIndex: 0, hasToolCalls: false, finished: false, usage: null });

  const toolStartEvents = events.filter((event) => event.type === 'tool_call_start');
  assert.equal(toolStartEvents.length, 2);
  assert.match(toolStartEvents[0].id, /^toolu_aih_1_[a-zA-Z0-9_-]+$/);
  assert.match(toolStartEvents[1].id, /^toolu_aih_2_[a-zA-Z0-9_-]+$/);
  assert.notEqual(toolStartEvents[0].id, toolStartEvents[1].id);
  assert.equal(__private.decodeAnthropicToolUseId(toolStartEvents[0].id), 'tool/use.id:2');
  assert.equal(__private.decodeAnthropicToolUseId(toolStartEvents[1].id), 'tool:use.id/2');

  const fallbackEvents = anthropicMessageToCanonicalEvents(message);
  const fallbackToolStartEvents = fallbackEvents.filter((event) => event.type === 'tool_call_start');
  assert.equal(fallbackToolStartEvents[0].id, message.content[0].id);
  assert.equal(fallbackToolStartEvents[1].id, message.content[1].id);
  assert.equal(__private.decodeAnthropicToolUseId(fallbackToolStartEvents[0].id), 'tool/use.id:1');
  assert.equal(__private.decodeAnthropicToolUseId(fallbackToolStartEvents[1].id), 'tool:use.id/1');
});

test('Code Assist Anthropic renderer does not reuse fallback tool ids from request history', () => {
  const codec = __private.createAnthropicToolUseIdCodec({ reservedClientIds: ['toolu_1'] });
  assert.equal(codec.toClient('', 1), 'toolu_2');
  assert.equal(codec.toUpstream('toolu_2'), 'toolu_2');

  const message = __private.renderCodeAssistAnthropicMessage({
    response: {
      responseId: 'resp_blank_tool_id',
      candidates: [{
        finishReason: 'UNEXPECTED_TOOL_CALL',
        content: {
          parts: [{
            functionCall: {
              name: 'Bash',
              args: { command: 'pwd' }
            }
          }]
        }
      }]
    }
  }, 'claude-4-6-thinking', __private.createToolNameCodec([{ name: 'Bash' }]), {
    reservedClientToolUseIds: ['toolu_1']
  });

  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(message.content, [{
    type: 'tool_use',
    id: 'toolu_2',
    name: 'Bash',
    input: { command: 'pwd' }
  }]);

  const events = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      finishReason: 'UNEXPECTED_TOOL_CALL',
      content: {
        parts: [{
          functionCall: {
            name: 'Bash',
            args: { command: 'pwd' }
          }
        }]
      }
    }]
  }, {
    nextToolIndex: 0,
    hasToolCalls: false,
    finished: false,
    usage: null,
    toolUseIdCodec: __private.createAnthropicToolUseIdCodec({ reservedClientIds: ['toolu_1'] })
  });

  assert.deepEqual(events.slice(0, 3), [
    { type: 'tool_call_start', index: 0, id: 'toolu_2', name: 'Bash' },
    { type: 'tool_call_delta', index: 0, id: 'toolu_2', name: 'Bash', delta: '{"command":"pwd"}' },
    { type: 'tool_call_done', index: 0, id: 'toolu_2', name: 'Bash' }
  ]);
});

test('Code Assist Anthropic adapter collects tool ids from prior Claude history', () => {
  const ids = __private.collectAnthropicToolUseIds([
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'package.json' } }]
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'package content' }]
    },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'pwd' } }]
    }
  ]);

  assert.deepEqual(ids, ['toolu_1', 'toolu_2']);
});

test('Code Assist Anthropic adapter decodes Claude-safe tool ids back to AGY ids on the next request', () => {
  const clientToolUseId = __private.sanitizeAnthropicToolUseId('tool/use.id:1', 1);
  const toolNameCodec = __private.createToolNameCodec([{ name: 'Read' }]);
  const normalized = __private.normalizeAnthropicMessagesForCodeAssist(
    [
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: clientToolUseId,
          name: 'Read',
          input: { file_path: 'package.json' }
        }]
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: clientToolUseId,
          content: 'package content'
        }]
      }
    ],
    '',
    resolveCodeAssistProviderStrategy('agy'),
    toolNameCodec
  );

  assert.equal(__private.decodeAnthropicToolUseId(clientToolUseId), 'tool/use.id:1');
  assert.equal(normalized.contents[0].parts[0].functionCall.id, 'tool/use.id:1');
  assert.equal(normalized.contents[1].parts[0].functionResponse.id, 'tool/use.id:1');
  assert.equal(normalized.contents[1].parts[0].functionResponse.name, 'Read');
  assert.equal(normalized.contents[1].parts[0].functionResponse.response.result, 'package content');
});

test('Code Assist provider strategy owns adaptive thinking wire shape', () => {
  assert.deepEqual(
    resolveCodeAssistAdaptiveThinkingConfig(resolveCodeAssistProviderStrategy('agy'), { effort: 'medium' }),
    {
      includeThoughts: true,
      thinkingBudget: -1
    }
  );
  assert.deepEqual(
    resolveCodeAssistAdaptiveThinkingConfig(resolveCodeAssistProviderStrategy('gemini'), { effort: 'medium' }),
    {
      includeThoughts: true,
      thinkingLevel: 'medium'
    }
  );
});

test('Code Assist Anthropic adapter maps Claude adaptive thinking config for AGY', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-test' })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const adaptive = await __private.buildCodeAssistAnthropicGenerateContext(
    {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal'
    },
    {
      id: 'agy-1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'claude-4-6-thinking',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' }
    },
    800
  );

  assert.deepEqual(adaptive.payload.request.generationConfig.thinkingConfig, {
    includeThoughts: true,
    thinkingBudget: -1
  });
  assert.equal(adaptive.diagnostic.requestSummary.thinkingConfigMode, 'budget');
  assert.deepEqual(adaptive.diagnostic.requestSummary.thinkingConfigKeys, ['includeThoughts', 'thinkingBudget']);

  const auto = await __private.buildCodeAssistAnthropicGenerateContext(
    {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal'
    },
    {
      id: 'agy-1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'claude-4-6-thinking',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'auto' }
    },
    800
  );

  assert.deepEqual(auto.payload.request.generationConfig.thinkingConfig, {
    includeThoughts: true,
    thinkingBudget: -1
  });
  assert.equal(auto.diagnostic.requestSummary.thinkingConfigMode, 'budget');
  assert.deepEqual(auto.diagnostic.requestSummary.thinkingConfigKeys, ['includeThoughts', 'thinkingBudget']);
});

test('Code Assist Anthropic adapter omits unsupported temperature for AGY Claude Opus thinking', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-test' })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const context = await __private.buildCodeAssistAnthropicGenerateContext(
    {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal'
    },
    {
      id: 'agy-1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'claude-opus-4.6-thinking',
      max_tokens: 512,
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      messages: [{ role: 'user', content: '需要联网搜索最新方案' }]
    },
    800
  );

  const generationConfig = context.payload.request.generationConfig;
  assert.equal(context.originalModel, 'claude-opus-4.6-thinking');
  assert.equal(context.model, 'claude-opus-4-6-thinking');
  assert.equal(context.payload.model, 'claude-opus-4-6-thinking');
  assert.equal(context.diagnostic.publicModel, 'claude-opus-4-6-thinking');
  assert.equal(context.diagnostic.wireModel, 'claude-opus-4-6-thinking');
  assert.equal(Object.hasOwn(generationConfig, 'temperature'), false);
  assert.equal(generationConfig.maxOutputTokens, 512);
  assert.equal(generationConfig.topP, 0.9);
  assert.equal(generationConfig.topK, 40);
  assert.equal(Object.hasOwn(generationConfig, 'thinkingConfig'), false);
  assert.deepEqual(context.diagnostic.omittedGenerationConfigKeys, ['temperature']);
  assert.deepEqual(context.diagnostic.generationConfigCapabilityRules.map((rule) => [rule.id, rule.reason]), [[
    'agy:code_assist:claude_opus_thinking:omit-temperature',
    'agy_claude_opus_thinking_code_assist_does_not_accept_generation_temperature'
  ]]);
  assert.deepEqual(context.diagnostic.requestSummary.omittedGenerationConfigKeys, ['temperature']);
  assert.equal(context.diagnostic.requestSummary.generationConfigKeys.includes('temperature'), false);
});

test('Code Assist Anthropic adapter sends Claude custom tools to AGY direct route as parameters', async (t) => {
  let generateBody = null;
  const diagnostics = [];
  const customTools = Array.from({ length: 12 }, (_item, index) => ({
    type: 'custom',
    custom: {
      name: index === 11 ? 'JS' : `mcp__Repo Tool__read_${index}`,
      description: `Workspace tool ${index}`,
      input_schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          file_path: { type: ['string', 'null'] }
        },
        required: ['file_path'],
        unevaluatedProperties: false
      }
    }
  }));
  t.mock.method(global, 'fetch', async (url, init) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-test' })
      };
    }
    if (safeUrl.includes(':streamGenerateContent')) {
      generateBody = JSON.parse(String(init && init.body || '{}'));
      const chunk = [
        'data: ',
        JSON.stringify({
          traceId: 'trace-custom-tool',
          candidates: [{
            finishReason: 'STOP',
            content: { parts: [{ text: 'ok' }] }
          }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 }
        }),
        '\n\n'
      ].join('');
      return {
        ok: true,
        status: 200,
        body: {
          async *[Symbol.asyncIterator]() {
            yield chunk;
          }
        }
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const result = await fetchCodeAssistAnthropicMessage(
    {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      providerProtocolRoute: resolveDirectProviderProtocolRoute('anthropic_messages', 'agy'),
      sourceClientProtocol: 'anthropic_messages',
      protocolAdapterPath: [],
      appendGeminiCodeAssistDiagnostic: (item) => diagnostics.push(item)
    },
    {
      id: 'agy-1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'claude-opus-4.6-thinking',
      messages: [{ role: 'user', content: '读取配置' }],
      tools: customTools,
      tool_choice: { type: 'tool', name: 'JS' }
    },
    800
  );

  assert.deepEqual(result.content, [{ type: 'text', text: 'ok' }]);
  const declarations = generateBody.request.tools[0].functionDeclarations;
  assert.equal(declarations.length, 12);
  const declaration = declarations[0];
  assert.equal(declaration.name, 'mcp__Repo_Tool__read_0');
  assert.equal(declaration.custom, undefined);
  assert.equal(declaration.input_schema, undefined);
  assert.equal(declaration.parametersJsonSchema, undefined);
  assert.equal(declaration.parameters.$schema, undefined);
  assert.equal(declaration.parameters.unevaluatedProperties, undefined);
  assert.equal(declaration.parameters.type, 'object');
  assert.equal(declaration.parameters.properties.file_path.type, 'string');
  assert.deepEqual(declaration.parameters.required, ['file_path']);
  assert.equal(declarations[11].name, 'JS');
  assert.equal(declarations[11].custom, undefined);
  assert.equal(declarations[11].input_schema, undefined);
  assert.equal(declarations[11].parametersJsonSchema, undefined);
  assert.equal(declarations[11].parameters.type, 'object');
  const toolJson = JSON.stringify(generateBody.request.tools);
  assert.equal(toolJson.includes('"custom"'), false);
  assert.equal(toolJson.includes('"input_schema"'), false);
  assert.deepEqual(generateBody.request.toolConfig, {
    functionCallingConfig: {
      mode: 'AUTO',
      allowedFunctionNames: ['JS']
    }
  });
  assert.equal(diagnostics[0].requestProtocol, 'anthropic_messages_direct');
  assert.equal(diagnostics[0].method, 'streamGenerateContent');
  assert.equal(diagnostics[0].requestEnvelope, 'antigravity_agent');
  assert.equal(diagnostics[0].requestSummary.toolDeclarationSchemaKey, 'parameters');
  assert.equal(diagnostics[0].requestSummary.toolConfigMode, 'AUTO');
  assert.deepEqual(diagnostics[0].requestSummary.allowedFunctionNames, ['JS']);
  assert.equal(diagnostics[0].requestSummary.toolDeclarationCount, 12);
  assert.equal(diagnostics[0].requestSummary.toolNames[11], 'JS');
});

test('Code Assist Anthropic adapter omits AGY Claude TaskUpdate tool declaration', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-test' })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const context = await __private.buildCodeAssistAnthropicGenerateContext(
    {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal'
    },
    {
      id: 'agy-1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'claude-opus-4.6-thinking',
      messages: [{ role: 'user', content: 'update task' }],
      tools: [
        {
          name: 'Read',
          description: 'Read file',
          input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
        },
        {
          name: 'TaskUpdate',
          description: 'Update task state',
          input_schema: {
            type: 'object',
            properties: {
              taskId: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] }
            },
            required: ['taskId']
          }
        },
        {
          name: 'Write',
          description: 'Write file',
          input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } } }
        }
      ],
      tool_choice: { type: 'tool', name: 'TaskUpdate' }
    },
    800
  );

  const declarations = context.payload.request.tools[0].functionDeclarations;
  assert.deepEqual(declarations.map((item) => item.name), ['Read', 'Write']);
  assert.deepEqual(context.payload.request.toolConfig, {
    functionCallingConfig: { mode: 'AUTO' }
  });
  assert.equal(context.diagnostic.requestSummary.toolDeclarationCount, 2);
  assert.deepEqual(context.diagnostic.requestSummary.omittedToolNames, ['TaskUpdate']);
  assert.equal(context.diagnostic.requestSummary.allowedFunctionNames, undefined);
});

test('Code Assist Anthropic adapter sends provider descriptor wire model ids', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-test' })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const context = await __private.buildCodeAssistAnthropicGenerateContext(
    {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal'
    },
    {
      id: 'agy-1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1',
      codeAssistModelDescriptors: [{
        provider: 'agy',
        id: 'public-reasoning',
        modelId: 'public-reasoning',
        wireId: 'wire-reasoning',
        upstreamModel: 'wire-reasoning',
        aliases: ['Public Reasoning']
      }]
    },
    {
      model: 'Public Reasoning',
      messages: [{ role: 'user', content: 'hi' }]
    },
    800
  );

  assert.equal(context.originalModel, 'Public Reasoning');
  assert.equal(context.model, 'wire-reasoning');
  assert.equal(context.payload.model, 'wire-reasoning');
  assert.equal(context.diagnostic.publicModel, 'public-reasoning');
  assert.equal(context.diagnostic.wireModel, 'wire-reasoning');
});

test('Code Assist Anthropic adapter keeps adaptive thinking level for non-AGY providers', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/gemini-test' })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const context = await __private.buildCodeAssistAnthropicGenerateContext(
    {
      provider: 'gemini',
      geminiBaseUrl: 'https://cloudcode-pa.googleapis.com/v1internal'
    },
    {
      id: 'gemini-1',
      provider: 'gemini',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'gemini-3.1-pro-high',
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' }
    },
    800
  );

  assert.deepEqual(context.payload.request.generationConfig.thinkingConfig, {
    includeThoughts: true,
    thinkingLevel: 'medium'
  });
  assert.equal(context.diagnostic.requestSummary.thinkingConfigMode, 'level');
  assert.deepEqual(context.diagnostic.requestSummary.thinkingConfigKeys, ['includeThoughts', 'thinkingLevel']);
});

test('Code Assist Anthropic adapter suppresses AGY thinking config after dropping unsigned thinking history', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-test' })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const context = await __private.buildCodeAssistAnthropicGenerateContext(
    {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal'
    },
    {
      id: 'agy-1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'claude-4-6-thinking',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '历史 thinking 缺少可用签名。', signature: 'not-a-claude-signature' },
          { type: 'text', text: '继续。' }
        ]
      }],
      thinking: { type: 'enabled', budget_tokens: 8000 }
    },
    800
  );

  assert.equal(context.payload.request.generationConfig.thinkingConfig, undefined);
  assert.deepEqual(context.payload.request.contents, [{
    role: 'model',
    parts: [{ text: '继续。' }]
  }]);
  assert.equal(context.diagnostic.requestSummary.droppedUnsignedThinkingCount, 1);
});

test('Code Assist Anthropic adapter injects interleaved thinking hint only for Claude thinking tools', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-test' })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const baseOptions = {
    provider: 'agy',
    agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal'
  };
  const account = {
    id: 'agy-1',
    provider: 'agy',
    authType: 'oauth-personal',
    accessToken: 'token-1'
  };
  const tools = [{
    name: 'Read',
    description: 'Read file',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
  }];

  const withToolsAndThinking = await __private.buildCodeAssistAnthropicGenerateContext(
    baseOptions,
    account,
    {
      model: 'claude-4-6-thinking',
      system: [{ type: 'text', text: 'You are helpful.' }],
      messages: [{ role: 'user', content: 'hi' }],
      tools,
      thinking: { type: 'enabled', budget_tokens: 8000 }
    },
    800
  );
  assert.match(
    withToolsAndThinking.payload.request.systemInstruction.parts[0].text,
    /Interleaved thinking is enabled/
  );

  const toolsOnly = await __private.buildCodeAssistAnthropicGenerateContext(
    baseOptions,
    account,
    {
      model: 'claude-sonnet-4.6',
      system: [{ type: 'text', text: 'You are helpful.' }],
      messages: [{ role: 'user', content: 'hi' }],
      tools
    },
    800
  );
  assert.doesNotMatch(
    toolsOnly.payload.request.systemInstruction.parts[0].text,
    /Interleaved thinking is enabled/
  );

  const thinkingOnly = await __private.buildCodeAssistAnthropicGenerateContext(
    baseOptions,
    account,
    {
      model: 'claude-4-6-thinking',
      system: [{ type: 'text', text: 'You are helpful.' }],
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 8000 }
    },
    800
  );
  assert.doesNotMatch(
    thinkingOnly.payload.request.systemInstruction.parts[0].text,
    /Interleaved thinking is enabled/
  );

  const nonAgy = await __private.buildCodeAssistAnthropicGenerateContext(
    {
      provider: 'gemini',
      geminiBaseUrl: 'https://cloudcode-pa.googleapis.com/v1internal'
    },
    {
      id: 'gemini-1',
      provider: 'gemini',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'claude-4-6-thinking',
      system: [{ type: 'text', text: 'You are helpful.' }],
      messages: [{ role: 'user', content: 'hi' }],
      tools,
      thinking: { type: 'enabled', budget_tokens: 8000 }
    },
    800
  );
  assert.doesNotMatch(
    nonAgy.payload.request.systemInstruction.parts[0].text,
    /Interleaved thinking is enabled/
  );
});

test('Code Assist Anthropic adapter accepts string tool_choice values', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-test' })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const context = await __private.buildCodeAssistAnthropicGenerateContext(
    {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal'
    },
    {
      id: 'agy-1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'claude-4-6-thinking',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        name: 'Read',
        description: 'Read file',
        input_schema: { type: 'object', properties: { file_path: { type: 'string' } } }
      }],
      tool_choice: 'none'
    },
    800
  );

  assert.deepEqual(context.payload.request.toolConfig, {
    functionCallingConfig: { mode: 'NONE' }
  });
});

test('Code Assist Anthropic adapter uses AGY Claude supported tool mode', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/code-assist-test' })
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const tools = [{
    name: 'Read',
    description: 'Read file',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
  }];
  const agyOptions = {
    provider: 'agy',
    agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal'
  };
  const agyAccount = {
    id: 'agy-1',
    provider: 'agy',
    authType: 'oauth-personal',
    accessToken: 'token-1'
  };

  const defaultToolChoice = await __private.buildCodeAssistAnthropicGenerateContext(
    agyOptions,
    agyAccount,
    {
      model: 'claude-4-6-thinking',
      messages: [{ role: 'user', content: 'read package' }],
      tools
    },
    800
  );
  assert.deepEqual(defaultToolChoice.payload.request.toolConfig, {
    functionCallingConfig: { mode: 'AUTO' }
  });
  assert.equal(defaultToolChoice.diagnostic.requestSummary.toolConfigMode, 'AUTO');

  const namedToolChoice = await __private.buildCodeAssistAnthropicGenerateContext(
    agyOptions,
    agyAccount,
    {
      model: 'claude-4-6-thinking',
      messages: [{ role: 'user', content: 'read package' }],
      tools,
      tool_choice: { type: 'tool', name: 'Read' }
    },
    800
  );
  assert.deepEqual(namedToolChoice.payload.request.toolConfig, {
    functionCallingConfig: {
      mode: 'AUTO',
      allowedFunctionNames: ['Read']
    }
  });
  assert.equal(namedToolChoice.diagnostic.requestSummary.toolConfigMode, 'AUTO');
  assert.deepEqual(namedToolChoice.diagnostic.requestSummary.allowedFunctionNames, ['Read']);

  const disabledToolChoice = await __private.buildCodeAssistAnthropicGenerateContext(
    agyOptions,
    agyAccount,
    {
      model: 'claude-4-6-thinking',
      messages: [{ role: 'user', content: 'read package' }],
      tools,
      tool_choice: 'none'
    },
    800
  );
  assert.deepEqual(disabledToolChoice.payload.request.toolConfig, {
    functionCallingConfig: { mode: 'NONE' }
  });

  const geminiToolChoice = await __private.buildCodeAssistAnthropicGenerateContext(
    {
      provider: 'gemini',
      geminiBaseUrl: 'https://cloudcode-pa.googleapis.com/v1internal'
    },
    {
      id: 'gemini-1',
      provider: 'gemini',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'gemini-3.1-pro-high',
      messages: [{ role: 'user', content: 'read package' }],
      tools,
      tool_choice: 'auto'
    },
    800
  );
  assert.deepEqual(geminiToolChoice.payload.request.toolConfig, {
    functionCallingConfig: { mode: 'AUTO' }
  });
});

test('Code Assist Anthropic stream pieces convert tool calls to canonical tool events', () => {
  const state = { nextToolIndex: 0, hasToolCalls: false, finished: false, usage: null };
  const events = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      finishReason: 'UNEXPECTED_TOOL_CALL',
      content: {
        parts: [{
          functionCall: {
            id: 'toolu_bash_2',
            name: 'Bash',
            args: { command: 'pwd' }
          }
        }]
      }
    }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
  }, state);

  assert.deepEqual(events.slice(0, 3), [
    { type: 'tool_call_start', index: 0, id: 'toolu_bash_2', name: 'Bash' },
    { type: 'tool_call_delta', index: 0, id: 'toolu_bash_2', name: 'Bash', delta: '{"command":"pwd"}' },
    { type: 'tool_call_done', index: 0, id: 'toolu_bash_2', name: 'Bash' }
  ]);
  assert.equal(events[3].type, 'message_stop');
  assert.equal(events[3].finishReason, 'tool_use');
});

test('Code Assist Anthropic stream pieces restore sanitized tool names', () => {
  const state = {
    nextToolIndex: 0,
    hasToolCalls: false,
    finished: false,
    usage: null,
    toolNameCodec: __private.createToolNameCodec([{ name: 'mcp/server/read' }])
  };
  const events = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      finishReason: 'UNEXPECTED_TOOL_CALL',
      content: {
        parts: [{
          functionCall: {
            id: 'toolu_mcp_stream',
            name: 'mcp_server_read',
            args: { file_path: 'package.json' }
          }
        }]
      }
    }]
  }, state);

  assert.deepEqual(events.slice(0, 3), [
    { type: 'tool_call_start', index: 0, id: 'toolu_mcp_stream', name: 'mcp/server/read' },
    {
      type: 'tool_call_delta',
      index: 0,
      id: 'toolu_mcp_stream',
      name: 'mcp/server/read',
      delta: '{"file_path":"package.json"}'
    },
    { type: 'tool_call_done', index: 0, id: 'toolu_mcp_stream', name: 'mcp/server/read' }
  ]);
  assert.equal(events[3].finishReason, 'tool_use');
});

test('Code Assist Anthropic stream pieces assemble fragmented tool arguments', () => {
  const state = { nextToolIndex: 0, hasToolCalls: false, finished: false, usage: null };
  const firstEvents = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      content: {
        parts: [{
          functionCall: {
            id: 'toolu_read_fragmented',
            name: 'Read',
            args: '{"file_path":'
          }
        }]
      }
    }]
  }, state);

  assert.deepEqual(firstEvents, []);

  const secondEvents = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      finishReason: 'UNEXPECTED_TOOL_CALL',
      content: {
        parts: [{
          functionCall: {
            id: 'toolu_read_fragmented',
            name: 'Read',
            args: '"package.json"}'
          }
        }]
      }
    }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
  }, state);

  assert.deepEqual(secondEvents, [
    { type: 'tool_call_start', index: 0, id: 'toolu_read_fragmented', name: 'Read' },
    { type: 'tool_call_delta', index: 0, id: 'toolu_read_fragmented', name: 'Read', delta: '{"file_path":"package.json"}' },
    { type: 'tool_call_done', index: 0, id: 'toolu_read_fragmented', name: 'Read' },
    { type: 'message_stop', finishReason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
  ]);
});

test('Code Assist Anthropic stream pieces avoid duplicating cumulative tool arguments', () => {
  const state = { nextToolIndex: 0, hasToolCalls: false, finished: false, usage: null };
  const firstEvents = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      content: {
        parts: [{
          functionCall: {
            id: 'toolu_read_cumulative',
            name: 'Read',
            args: '{"file_path":'
          }
        }]
      }
    }]
  }, state);
  assert.deepEqual(firstEvents, []);

  const events = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      finishReason: 'UNEXPECTED_TOOL_CALL',
      content: {
        parts: [{
          functionCall: {
            id: 'toolu_read_cumulative',
            name: 'Read',
            args: '{"file_path":"package.json"}'
          }
        }]
      }
    }]
  }, state);

  assert.deepEqual(events, [
    { type: 'tool_call_start', index: 0, id: 'toolu_read_cumulative', name: 'Read' },
    { type: 'tool_call_delta', index: 0, id: 'toolu_read_cumulative', name: 'Read', delta: '{"file_path":"package.json"}' },
    { type: 'tool_call_done', index: 0, id: 'toolu_read_cumulative', name: 'Read' },
    { type: 'message_stop', finishReason: 'tool_use', usage: null }
  ]);
});

test('Code Assist Anthropic stream pieces continue tool arguments when later chunks omit id and name', () => {
  const state = { nextToolIndex: 0, hasToolCalls: false, finished: false, usage: null };
  const firstEvents = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      content: {
        parts: [{
          functionCall: {
            name: 'Bash',
            args: '{"command":'
          }
        }]
      }
    }]
  }, state);
  assert.deepEqual(firstEvents, []);

  const events = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      finishReason: 'UNEXPECTED_TOOL_CALL',
      content: {
        parts: [{
          functionCall: {
            args: '"pwd"}'
          }
        }]
      }
    }]
  }, state);

  assert.deepEqual(events, [
    { type: 'tool_call_start', index: 0, id: 'toolu_1', name: 'Bash' },
    { type: 'tool_call_delta', index: 0, id: 'toolu_1', name: 'Bash', delta: '{"command":"pwd"}' },
    { type: 'tool_call_done', index: 0, id: 'toolu_1', name: 'Bash' },
    { type: 'message_stop', finishReason: 'tool_use', usage: null }
  ]);
});

test('Code Assist Anthropic stream normalizes Write aliases before tool events', () => {
  const declarations = [{
    name: 'Write',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['file_path', 'content'],
      additionalProperties: false
    }
  }];
  const protocolDiagnostics = [];
  const state = {
    nextToolIndex: 0,
    hasToolCalls: false,
    finished: false,
    usage: null,
    requiredByName: createRequiredToolLookup(declarations, 'parametersJsonSchema'),
    schemaByName: createToolSchemaLookup(declarations, 'parametersJsonSchema'),
    toolProtocolDiagnosticContext: {
      requestId: 'req-stream-write-alias',
      provider: 'agy',
      accountId: 'agy-1',
      model: 'claude-4-6-thinking',
      sourceProtocol: 'gemini_code_assist_generate_content',
      targetProtocol: 'anthropic_messages',
      adapterPath: ['agy2claudeAdapter'],
      appendToolProtocolDiagnostic: (entry) => protocolDiagnostics.push(entry),
      writeToolProtocolDiagnosticFile: false
    }
  };
  const events = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      finishReason: 'UNEXPECTED_TOOL_CALL',
      content: {
        parts: [{
          functionCall: {
            id: 'toolu_write_stream_alias',
            name: 'Write',
            args: {
              file_path: 'tmp/stream.md',
              write_content: 'stream body'
            }
          }
        }]
      }
    }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
  }, state);

  assert.deepEqual(events, [
    { type: 'tool_call_start', index: 0, id: 'toolu_write_stream_alias', name: 'Write' },
    {
      type: 'tool_call_delta',
      index: 0,
      id: 'toolu_write_stream_alias',
      name: 'Write',
      delta: '{"file_path":"tmp/stream.md","content":"stream body"}'
    },
    { type: 'tool_call_done', index: 0, id: 'toolu_write_stream_alias', name: 'Write' },
    { type: 'message_stop', finishReason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
  ]);
  assert.equal(protocolDiagnostics.length, 1);
  assert.equal(protocolDiagnostics[0].action, 'normalized');
  assert.deepEqual(protocolDiagnostics[0].argKeys, ['file_path', 'write_content']);
  assert.deepEqual(protocolDiagnostics[0].normalizedKeys, ['content']);
});

test('Code Assist Anthropic stream normalizes Read line-count alias before tool events', () => {
  const declarations = [{
    name: 'Read',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' }
      },
      required: ['file_path'],
      additionalProperties: false
    }
  }];
  const protocolDiagnostics = [];
  const state = {
    nextToolIndex: 0,
    hasToolCalls: false,
    finished: false,
    usage: null,
    requiredByName: createRequiredToolLookup(declarations, 'parametersJsonSchema'),
    schemaByName: createToolSchemaLookup(declarations, 'parametersJsonSchema'),
    toolProtocolDiagnosticContext: {
      requestId: 'req-stream-read-lines-required',
      provider: 'agy',
      accountId: 'agy-1',
      model: 'claude-4-6-thinking',
      sourceProtocol: 'gemini_code_assist_generate_content',
      targetProtocol: 'anthropic_messages',
      adapterPath: ['agy2claudeAdapter'],
      appendToolProtocolDiagnostic: (entry) => protocolDiagnostics.push(entry),
      writeToolProtocolDiagnosticFile: false
    }
  };
  const events = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      finishReason: 'UNEXPECTED_TOOL_CALL',
      content: {
        parts: [{
          functionCall: {
            id: 'toolu_read_stream_lines_required',
            name: 'Read',
            args: {
              file_path: 'package.json',
              lines_required: 40
            }
          }
        }]
      }
    }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
  }, state);

  assert.deepEqual(events, [
    { type: 'tool_call_start', index: 0, id: 'toolu_read_stream_lines_required', name: 'Read' },
    {
      type: 'tool_call_delta',
      index: 0,
      id: 'toolu_read_stream_lines_required',
      name: 'Read',
      delta: '{"file_path":"package.json","limit":40}'
    },
    { type: 'tool_call_done', index: 0, id: 'toolu_read_stream_lines_required', name: 'Read' },
    { type: 'message_stop', finishReason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
  ]);
  assert.equal(protocolDiagnostics.length, 1);
  assert.equal(protocolDiagnostics[0].action, 'normalized');
  assert.deepEqual(protocolDiagnostics[0].argKeys, ['file_path', 'lines_required']);
  assert.deepEqual(protocolDiagnostics[0].normalizedKeys, ['limit']);
  assert.deepEqual(protocolDiagnostics[0].removedKeys, ['lines_required']);
});

test('Code Assist Anthropic stream derives empty TaskCreate input from preceding thinking chunk', () => {
  const declarations = [{
    name: 'TaskCreate',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        description: { type: 'string' },
        activeForm: { type: 'string' }
      },
      required: ['subject', 'description'],
      additionalProperties: false
    }
  }];
  const protocolDiagnostics = [];
  const state = {
    nextToolIndex: 0,
    hasToolCalls: false,
    finished: false,
    usage: null,
    requiredByName: createRequiredToolLookup(declarations, 'parametersJsonSchema'),
    schemaByName: createToolSchemaLookup(declarations, 'parametersJsonSchema'),
    toolProtocolDiagnosticContext: {
      requestId: 'req-stream-task-create-context',
      provider: 'agy',
      accountId: 'agy-1',
      model: 'claude-4-6-thinking',
      sourceProtocol: 'gemini_code_assist_generate_content',
      targetProtocol: 'anthropic_messages',
      adapterPath: ['agy2claudeAdapter'],
      appendToolProtocolDiagnostic: (entry) => protocolDiagnostics.push(entry),
      writeToolProtocolDiagnosticFile: false
    }
  };

  const thinkingEvents = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      content: {
        parts: [{
          thought: true,
          text: '**Developing SSH Host Persistence**\n\nPersist backend SSH host configurations and construct the API routing layer.'
        }]
      }
    }]
  }, state);
  const toolEvents = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      finishReason: 'UNEXPECTED_TOOL_CALL',
      content: {
        parts: [{
          functionCall: {
            id: 'toolu_task_create_stream_context',
            name: 'TaskCreate',
            args: {}
          }
        }]
      }
    }]
  }, state);

  assert.deepEqual(thinkingEvents, [{
    type: 'content_delta',
    contentType: 'thinking',
    text: '**Developing SSH Host Persistence**\n\nPersist backend SSH host configurations and construct the API routing layer.'
  }]);
  assert.deepEqual(toolEvents, [
    { type: 'tool_call_start', index: 0, id: 'toolu_task_create_stream_context', name: 'TaskCreate' },
    {
      type: 'tool_call_delta',
      index: 0,
      id: 'toolu_task_create_stream_context',
      name: 'TaskCreate',
      delta: '{"subject":"Developing SSH Host Persistence","description":"Persist backend SSH host configurations and construct the API routing layer."}'
    },
    { type: 'tool_call_done', index: 0, id: 'toolu_task_create_stream_context', name: 'TaskCreate' },
    { type: 'message_stop', finishReason: 'tool_use', usage: null }
  ]);
  assert.equal(protocolDiagnostics.length, 1);
  assert.equal(protocolDiagnostics[0].action, 'normalized');
  assert.equal(protocolDiagnostics[0].reason, 'context_derived');
  assert.deepEqual(protocolDiagnostics[0].argKeys, []);
  assert.deepEqual(protocolDiagnostics[0].normalizedKeys, ['subject', 'description']);
});

test('Code Assist Anthropic stream finalizer closes no-argument tool calls generically', () => {
  const state = { nextToolIndex: 0, hasToolCalls: false, finished: false, usage: null };
  const events = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      content: {
        parts: [{
          functionCall: {
            id: 'toolu_todo_read_stream',
            name: 'TodoRead'
          }
        }]
      }
    }]
  }, state);
  const finalEvents = __private.finalizeCodeAssistStreamState(state);

  assert.deepEqual(events, []);
  assert.deepEqual(finalEvents, [
    { type: 'tool_call_start', index: 0, id: 'toolu_todo_read_stream', name: 'TodoRead' },
    { type: 'tool_call_delta', index: 0, id: 'toolu_todo_read_stream', name: 'TodoRead', delta: '{}' },
    { type: 'tool_call_done', index: 0, id: 'toolu_todo_read_stream', name: 'TodoRead' }
  ]);
});

test('Code Assist Anthropic stream diagnostics record unmatched argument chunks generically', () => {
  const state = { nextToolIndex: 0, hasToolCalls: false, finished: false, usage: null };
  const events = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      content: {
        parts: [{
          functionCall: {
            args: '{"file_path":"package.json"}'
          }
        }]
      }
    }]
  }, state);

  assert.deepEqual(events, []);
  assert.deepEqual(state.streamToolDiagnostics, [{
    type: 'tool_call_chunk_unmatched',
    hasId: false,
    hasName: false,
    hasArgs: true,
    openToolCallCount: 0,
    argLength: 28
  }]);
});

test('Code Assist Anthropic stream diagnostics flag incomplete JSON when closing tool arguments', () => {
  const state = { nextToolIndex: 0, hasToolCalls: false, finished: false, usage: null };
  __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      content: {
        parts: [{
          functionCall: {
            id: 'toolu_read_incomplete',
            name: 'Read',
            args: '{"file_path":'
          }
        }]
      }
    }]
  }, state);

  const finalEvents = __private.finalizeCodeAssistStreamState(state);

  assert.deepEqual(finalEvents, [{
    type: 'content_delta',
    contentType: 'text',
    text: 'Upstream returned invalid tool call input; suppressed execution for: Read'
  }]);
  assert.deepEqual(state.streamToolDiagnostics, [{
    type: 'tool_call_arguments_closed_incomplete_json',
    id: 'toolu_read_incomplete',
    name: 'Read',
    argumentLength: 13
  }]);
});

test('Code Assist Anthropic stream suppresses missing required tool inputs generically', () => {
  const state = {
    nextToolIndex: 0,
    hasToolCalls: false,
    finished: false,
    usage: null,
    requiredByName: new Map([['Lookup', ['query']]])
  };
  const events = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      finishReason: 'UNEXPECTED_TOOL_CALL',
      content: {
        parts: [{
          functionCall: {
            id: 'toolu_lookup_missing_query',
            name: 'Lookup',
            args: {}
          }
        }]
      }
    }]
  }, state);

  assert.deepEqual(events, [
    {
      type: 'content_delta',
      contentType: 'text',
      text: 'Upstream returned invalid tool call input; suppressed execution for: Lookup missing required input: query'
    },
    { type: 'message_stop', finishReason: 'end_turn', usage: null }
  ]);
  assert.deepEqual(state.streamToolDiagnostics, [{
    type: 'tool_call_invalid_input',
    id: 'toolu_lookup_missing_query',
    name: 'Lookup',
    missingRequired: ['query']
  }]);
});

test('Code Assist Anthropic stream flushes tool diagnostics through request diagnostics hook', async (t) => {
  const diagnostics = [];
  t.mock.method(global, 'fetch', async (url) => {
    const safeUrl = String(url || '');
    if (safeUrl.includes(':loadCodeAssist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ cloudaicompanionProject: 'projects/agy-test' })
      };
    }
    if (safeUrl.includes(':streamGenerateContent')) {
      return {
        ok: true,
        status: 200,
        body: (async function* () {
          yield Buffer.from(
            'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"args":"{\\"file_path\\":\\"package.json\\"}"}}]}}]}}\n\n'
          );
        })()
      };
    }
    throw new Error(`unexpected_url_${safeUrl}`);
  });

  const stream = await fetchCodeAssistAnthropicMessageStream(
    {
      provider: 'agy',
      agyBaseUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
      appendGeminiCodeAssistDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    },
    {
      id: 'agy-1',
      provider: 'agy',
      authType: 'oauth-personal',
      accessToken: 'token-1'
    },
    {
      model: 'claude-4-6-thinking',
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: '读取文件' }] }],
      tools: [{
        name: 'Read',
        description: 'Read file',
        input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
      }]
    },
    800
  );

  for await (const _event of stream) {}

  const streamDiagnostic = diagnostics.find((item) => Array.isArray(item.streamToolDiagnostics));
  assert.ok(streamDiagnostic);
  assert.deepEqual(streamDiagnostic.streamToolDiagnostics, [{
    type: 'tool_call_chunk_unmatched',
    hasId: false,
    hasName: false,
    hasArgs: true,
    openToolCallCount: 0,
    argLength: 28
  }]);
});

test('Code Assist Anthropic stream pieces preserve thinking deltas and signatures', () => {
  const state = { nextToolIndex: 0, hasToolCalls: false, finished: false, usage: null };
  const events = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      content: {
        parts: [{
          thought: true,
          text: '分析工具参数。',
          thoughtSignature: 'sig_stream_piece_1'
        }]
      }
    }]
  }, state);

  assert.deepEqual(events, [
    { type: 'content_delta', contentType: 'thinking', text: '分析工具参数。' },
    { type: 'content_delta', contentType: 'thinking_signature', signature: 'sig_stream_piece_1' }
  ]);
});

test('Code Assist Anthropic renderer reads wrapped AGY response metadata', () => {
  const message = __private.renderCodeAssistAnthropicMessage({
    response: {
      responseId: 'resp_wrapped_1',
      modelVersion: 'gemini-2.5-pro',
      candidates: [{
        finishReason: 'UNEXPECTED_TOOL_CALL',
        content: {
          parts: [{
            functionCall: {
              id: 'toolu_read_3',
              name: 'Read',
              args: { file_path: '/tmp/demo.txt' }
            }
          }]
        }
      }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 }
    }
  }, 'claude-4-6-thinking');

  assert.equal(message.id, 'resp_wrapped_1');
  assert.equal(message.model, 'claude-4-6-thinking');
  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(message.content, [{
    type: 'tool_use',
    id: 'toolu_read_3',
    name: 'Read',
    input: { file_path: '/tmp/demo.txt' }
  }]);
});

test('Code Assist Anthropic renderer preserves AGY thinking blocks and signatures', () => {
  const message = __private.renderCodeAssistAnthropicMessage({
    response: {
      responseId: 'resp_thinking_1',
      modelVersion: 'gemini-2.5-pro',
      candidates: [{
        finishReason: 'STOP',
        content: {
          parts: [
            { thought: true, text: '先检查上下文。', thoughtSignature: 'sig_thinking_1' },
            { text: '可以继续。' }
          ]
        }
      }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 9 }
    }
  }, 'claude-4-6-thinking');

  assert.equal(message.id, 'resp_thinking_1');
  assert.equal(message.model, 'claude-4-6-thinking');
  assert.equal(message.stop_reason, 'end_turn');
  assert.deepEqual(message.content, [
    { type: 'thinking', thinking: '先检查上下文。', signature: 'sig_thinking_1' },
    { type: 'text', text: '可以继续。' }
  ]);
  assert.deepEqual(message.usage, { input_tokens: 4, output_tokens: 5 });
});

test('Code Assist Anthropic renderer repairs Claude goal evaluator fenced JSON', () => {
  const responsePolicy = __private.resolveClaudeStopHookJsonResponsePolicy({
    model: 'claude-opus-4.6-thinking',
    stream: true,
    messages: [{ role: 'user', content: [{ type: 'text', text: CLAUDE_GOAL_EVALUATOR_PROMPT }] }],
    tools: []
  });

  assert.ok(responsePolicy);
  const message = __private.renderCodeAssistAnthropicMessage({
    response: {
      responseId: 'resp_goal_hook_fence',
      candidates: [{
        finishReason: 'STOP',
        content: {
          parts: [{ text: '```json\n{"ok":true,"reason":"done"}\n```' }]
        }
      }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 }
    }
  }, 'claude-opus-4.6-thinking', __private.createToolNameCodec([]), {
    responsePolicy
  });

  assert.deepEqual(message.content, [{
    type: 'text',
    text: '{"ok":true,"reason":"done"}'
  }]);
});

test('Code Assist Anthropic renderer extracts Claude goal evaluator JSON from surrounding text', () => {
  const responsePolicy = __private.resolveClaudeStopHookJsonResponsePolicy({
    model: 'claude-opus-4.6-thinking',
    messages: [{ role: 'user', content: [{ type: 'text', text: CLAUDE_GOAL_EVALUATOR_PROMPT }] }],
    tools: []
  });

  assert.ok(responsePolicy);
  const message = __private.renderCodeAssistAnthropicMessage({
    response: {
      responseId: 'resp_goal_hook_extracted',
      candidates: [{
        finishReason: 'STOP',
        content: {
          parts: [{ text: 'I checked the transcript.\n{"ok":false,"reason":"not complete","impossible":true}\nThanks.' }]
        }
      }]
    }
  }, 'claude-opus-4.6-thinking', __private.createToolNameCodec([]), {
    responsePolicy
  });

  assert.deepEqual(message.content, [{
    type: 'text',
    text: '{"ok":false,"impossible":true,"reason":"not complete"}'
  }]);
});

test('Code Assist Anthropic stream repairs Claude goal evaluator prompt echo', () => {
  const responsePolicy = __private.resolveClaudeStopHookJsonResponsePolicy({
    model: 'claude-opus-4.6-thinking',
    stream: true,
    messages: [{ role: 'user', content: [{ type: 'text', text: CLAUDE_GOAL_EVALUATOR_PROMPT }] }],
    tools: []
  });
  const state = {
    nextToolIndex: 0,
    hasToolCalls: false,
    finished: false,
    usage: null,
    responsePolicy
  };

  const firstEvents = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      content: { parts: [{ text: CLAUDE_GOAL_EVALUATOR_PROMPT }] }
    }]
  }, state);
  assert.deepEqual(firstEvents, []);

  const finalEvents = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{ finishReason: 'STOP', content: { parts: [] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
  }, state);

  assert.equal(finalEvents.length, 2);
  assert.equal(finalEvents[0].type, 'content_delta');
  assert.equal(finalEvents[0].contentType, 'text');
  const repaired = JSON.parse(finalEvents[0].text);
  assert.equal(repaired.ok, false);
  assert.match(repaired.reason, /AIH repaired invalid Claude goal evaluator output/);
  assert.deepEqual(finalEvents[1], {
    type: 'message_stop',
    finishReason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
  });
});

test('Code Assist Anthropic stream extracts split Claude goal evaluator JSON at finish', () => {
  const responsePolicy = __private.resolveClaudeStopHookJsonResponsePolicy({
    model: 'claude-opus-4.6-thinking',
    stream: true,
    messages: [{ role: 'user', content: [{ type: 'text', text: CLAUDE_GOAL_EVALUATOR_PROMPT }] }],
    tools: []
  });
  const state = {
    nextToolIndex: 0,
    hasToolCalls: false,
    finished: false,
    usage: null,
    responsePolicy
  };

  assert.deepEqual(__private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{ content: { parts: [{ text: 'Result:\n{"ok":' }] } }]
  }, state), []);
  assert.deepEqual(__private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{ content: { parts: [{ text: 'true,"reason":"done"}\n' }] } }]
  }, state), []);

  const finalEvents = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{ finishReason: 'STOP', content: { parts: [] } }]
  }, state);

  assert.equal(finalEvents[0].type, 'content_delta');
  assert.equal(finalEvents[0].contentType, 'text');
  assert.equal(finalEvents[0].text, '{"ok":true,"reason":"done"}');
  assert.equal(finalEvents[1].type, 'message_stop');
  assert.equal(finalEvents[1].finishReason, 'end_turn');
});

test('Code Assist Anthropic goal evaluator policy does not apply to normal tool requests', () => {
  assert.equal(__private.resolveClaudeStopHookJsonResponsePolicy({
    model: 'claude-opus-4.6-thinking',
    messages: [{ role: 'user', content: [{ type: 'text', text: CLAUDE_GOAL_EVALUATOR_PROMPT }] }],
    tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }]
  }), null);
});

test('Code Assist Anthropic adapter normalizes AGY thinking signatures at the Claude boundary', () => {
  const clientSignature = 'Eclient_signature_1';
  const upstreamSignature = Buffer.from(clientSignature, 'utf8').toString('base64');
  assert.equal(__private.decodeCodeAssistThoughtSignature(upstreamSignature), clientSignature);
  assert.equal(__private.encodeCodeAssistThoughtSignature(clientSignature), upstreamSignature);

  const codec = __private.createToolNameCodec([{ name: 'Read' }]);
  const normalized = __private.normalizeAnthropicMessagesForCodeAssist(
    [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '先判断是否需要读文件。', signature: clientSignature },
        { type: 'tool_use', id: 'toolu_read_sig', name: 'Read', input: { file_path: 'package.json' } }
      ]
    }],
    '',
    resolveCodeAssistProviderStrategy('agy'),
    codec
  );
  assert.equal(normalized.contents[0].parts[0].thoughtSignature, upstreamSignature);
  assert.equal(normalized.contents[0].parts[1].thoughtSignature, upstreamSignature);

  const rendered = __private.renderCodeAssistAnthropicMessage({
    response: {
      responseId: 'resp_signature_1',
      candidates: [{
        finishReason: 'STOP',
        content: {
          parts: [{
            thought: true,
            text: '先判断是否需要读文件。',
            thoughtSignature: upstreamSignature
          }]
        }
      }],
      usageMetadata: { promptTokenCount: 4, thoughtsTokenCount: 3, totalTokenCount: 7 }
    }
  }, 'claude-4-6-thinking');
  assert.equal(rendered.content[0].signature, clientSignature);

  const events = __private.codeAssistStreamPieceToCanonicalEvents({
    candidates: [{
      content: {
        parts: [{
          thought: true,
          text: '先判断是否需要读文件。',
          thoughtSignature: upstreamSignature
        }]
      }
    }]
  }, { nextToolIndex: 0, hasToolCalls: false, finished: false, usage: null });
  assert.deepEqual(events[1], {
    type: 'content_delta',
    contentType: 'thinking_signature',
    signature: clientSignature
  });
});

test('Code Assist Anthropic adapter drops invalid client thinking signatures before AGY', () => {
  const codec = __private.createToolNameCodec([{ name: 'Read' }]);
  const normalized = __private.normalizeAnthropicMessagesForCodeAssist(
    [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'proxy generated thinking', signature: 'not-a-claude-signature' },
        { type: 'tool_use', id: 'toolu_read_invalid_sig', name: 'Read', input: { file_path: 'package.json' } }
      ]
    }],
    '',
    resolveCodeAssistProviderStrategy('agy'),
    codec
  );

  assert.equal(__private.encodeCodeAssistThoughtSignature('not-a-claude-signature'), '');
  assert.equal(normalized.contents[0].parts.length, 1);
  assert.equal(normalized.contents[0].parts[0].functionCall.name, 'Read');
  assert.equal(normalized.contents[0].parts[0].thoughtSignature, 'skip_thought_signature_validator');
});

test('Code Assist Anthropic canonical events render AGY thinking SSE before text and tools', () => {
  const message = {
    id: 'msg_thinking_stream',
    model: 'claude-4-6-thinking',
    content: [
      { type: 'thinking', thinking: '先想一步。', signature: 'sig_stream_1' },
      { type: 'text', text: '我需要读文件。' },
      { type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { file_path: 'package.json' } }
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 3, output_tokens: 4 }
  };
  const chunks = [];
  const renderer = createCanonicalRenderer('anthropic_messages', (chunk) => chunks.push(chunk), message.model);

  anthropicMessageToCanonicalEvents(message).forEach((event) => renderer.event(event));
  renderer.end();

  const out = chunks.join('');
  assert.match(out, /"content_block":\{"type":"thinking","thinking":""\}/);
  assert.match(out, /"delta":\{"type":"thinking_delta","thinking":"先想一步。"\}/);
  assert.match(out, /"delta":\{"type":"signature_delta","signature":"sig_stream_1"\}/);
  assert.match(out, /"content_block":\{"type":"text","text":""\}/);
  assert.match(out, /"content_block":\{"type":"tool_use","id":"toolu_read_1","name":"Read","input":\{\}\}/);
  assert.match(out, /"stop_reason":"tool_use"/);
});
