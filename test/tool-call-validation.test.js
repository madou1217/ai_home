const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectToolRequirementsFromDeclarations,
  createRequiredToolLookup,
  formatInvalidToolCallText,
  getFunctionCallArgsDiagnostic,
  parseFunctionCallInput,
  readRequiredKeysFromToolDeclaration,
  validateFunctionCallInput
} = require('../lib/protocol/tool-call-validation');
const {
  createToolSchemaLookup,
  evaluateFunctionCallInput
} = require('../lib/protocol/tool-call-normalization');

test('tool call validation reads required inputs from common tool declaration shapes', () => {
  assert.deepEqual(
    readRequiredKeysFromToolDeclaration({
      name: 'Read',
      input_schema: { type: 'object', required: ['file_path', 'file_path', ''] }
    }),
    ['file_path']
  );
  assert.deepEqual(
    readRequiredKeysFromToolDeclaration({
      type: 'function',
      function: {
        name: 'Lookup',
        parameters: { type: 'object', required: ['query'] }
      }
    }),
    ['query']
  );
  assert.deepEqual(
    readRequiredKeysFromToolDeclaration({
      name: 'Fetch',
      parametersJsonSchema: { type: 'object', required: ['url'] }
    }, 'parametersJsonSchema'),
    ['url']
  );
});

test('tool call validation collects nested Code Assist function declarations', () => {
  const requirements = collectToolRequirementsFromDeclarations([{
    functionDeclarations: [{
      name: 'CustomFetch',
      parametersJsonSchema: { type: 'object', required: ['url'] }
    }]
  }]);

  assert.deepEqual(Array.from(requirements.entries()), [['CustomFetch', ['url']]]);
});

test('tool call validation rejects malformed and incomplete tool inputs generically', () => {
  const requiredByName = createRequiredToolLookup([
    { name: 'Lookup', parametersJsonSchema: { type: 'object', required: ['query'] } }
  ], 'parametersJsonSchema');

  assert.deepEqual(parseFunctionCallInput({
    name: 'Lookup',
    args: '{"query":"abc"}'
  }), { query: 'abc' });

  assert.deepEqual(getFunctionCallArgsDiagnostic({
    name: 'Lookup',
    args: '{"query":'
  }), {
    argsKind: 'string',
    argumentLength: 9,
    reason: 'invalid_json_object'
  });

  const missing = validateFunctionCallInput({
    id: 'toolu_lookup_missing',
    name: 'Lookup',
    args: {}
  }, requiredByName);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.diagnostic, {
    type: 'tool_call_invalid_input',
    id: 'toolu_lookup_missing',
    name: 'Lookup',
    missingRequired: ['query']
  });

  const malformed = validateFunctionCallInput({
    id: 'toolu_lookup_bad_json',
    name: 'Lookup',
    args: '{"query":'
  }, requiredByName);
  assert.equal(malformed.ok, false);
  assert.deepEqual(malformed.diagnostic, {
    type: 'tool_call_invalid_input',
    id: 'toolu_lookup_bad_json',
    name: 'Lookup',
    missingRequired: ['query'],
    argsKind: 'string',
    argumentLength: 9,
    reason: 'invalid_json_object'
  });

  assert.equal(
    formatInvalidToolCallText([malformed.diagnostic]),
    'Upstream returned invalid tool call input; suppressed execution for: Lookup missing required input: query (invalid_json_object)'
  );
});

test('tool call normalization maps known Claude tool aliases before validation', () => {
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
    }
  ];
  const requiredByName = createRequiredToolLookup(declarations, 'parametersJsonSchema');
  const schemaByName = createToolSchemaLookup(declarations, 'parametersJsonSchema');

  const writeContent = evaluateFunctionCallInput({
    id: 'toolu_write_alias',
    name: 'Write',
    args: { file_path: 'tmp/a.txt', write_content: 'hello' }
  }, requiredByName, schemaByName);

  assert.equal(writeContent.ok, true);
  assert.equal(writeContent.action, 'normalized');
  assert.equal(writeContent.reason, 'alias_mapped');
  assert.deepEqual(writeContent.input, { file_path: 'tmp/a.txt', content: 'hello' });
  assert.deepEqual(writeContent.normalizedKeys, ['content']);
  assert.deepEqual(writeContent.removedKeys, ['write_content']);

  const textAlias = evaluateFunctionCallInput({
    id: 'toolu_write_text',
    name: 'Write',
    args: { file_path: 'tmp/b.txt', text: 'hello from text' }
  }, requiredByName, schemaByName);

  assert.equal(textAlias.ok, true);
  assert.deepEqual(textAlias.input, { file_path: 'tmp/b.txt', content: 'hello from text' });
  assert.deepEqual(textAlias.removedKeys, ['text']);

  const fileContentAlias = evaluateFunctionCallInput({
    id: 'toolu_write_file_content',
    name: 'Write',
    args: { file_path: 'tmp/c.txt', file_content: 'hello from file_content' }
  }, requiredByName, schemaByName);

  assert.equal(fileContentAlias.ok, true);
  assert.deepEqual(fileContentAlias.input, { file_path: 'tmp/c.txt', content: 'hello from file_content' });
  assert.deepEqual(fileContentAlias.removedKeys, ['file_content']);

  const editAlias = evaluateFunctionCallInput({
    id: 'toolu_edit_replace_string',
    name: 'Edit',
    args: {
      file_path: 'tmp/a.txt',
      old_string: 'before',
      replace_string: 'after',
      replace_all: false
    }
  }, requiredByName, schemaByName);

  assert.equal(editAlias.ok, true);
  assert.deepEqual(editAlias.input, {
    file_path: 'tmp/a.txt',
    old_string: 'before',
    new_string: 'after',
    replace_all: false
  });
  assert.deepEqual(editAlias.normalizedKeys, ['new_string']);
  assert.deepEqual(editAlias.removedKeys, ['replace_string']);

  const readAlias = evaluateFunctionCallInput({
    id: 'toolu_read_lines_required',
    name: 'Read',
    args: {
      file_path: 'lib/server/code-assist-anthropic-adapter.js',
      lines_required: 80
    }
  }, requiredByName, schemaByName);

  assert.equal(readAlias.ok, true);
  assert.deepEqual(readAlias.input, {
    file_path: 'lib/server/code-assist-anthropic-adapter.js',
    limit: 80
  });
  assert.deepEqual(readAlias.normalizedKeys, ['limit']);
  assert.deepEqual(readAlias.removedKeys, ['lines_required']);
});

test('tool call normalization maps Agent message input into Claude prompt schema', () => {
  const declarations = [{
    name: 'Agent',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        prompt: { type: 'string' },
        subagent_type: { type: 'string' },
        model: { type: 'string' },
        run_in_background: { type: 'boolean' }
      },
      required: ['description', 'prompt'],
      additionalProperties: false
    }
  }];
  const requiredByName = createRequiredToolLookup(declarations, 'parametersJsonSchema');
  const schemaByName = createToolSchemaLookup(declarations, 'parametersJsonSchema');

  const normalized = evaluateFunctionCallInput({
    id: 'toolu_agent_message',
    name: 'Agent',
    args: {
      subagent_type: 'Explore',
      args: [],
      message: 'Please search the web/src folder for chat session persistence issues.'
    }
  }, requiredByName, schemaByName);

  assert.equal(normalized.ok, true);
  assert.equal(normalized.action, 'normalized');
  assert.deepEqual(normalized.input, {
    subagent_type: 'Explore',
    prompt: 'Please search the web/src folder for chat session persistence issues.',
    description: 'Please search the web/src folder for chat session persistence issues.'
  });
  assert.deepEqual(normalized.normalizedKeys, ['prompt', 'description']);
  assert.deepEqual(normalized.removedKeys, ['message', 'args']);
  assert.deepEqual(normalized.aliasMappings, [{ from: 'message', to: 'prompt' }]);

  const missingPrompt = evaluateFunctionCallInput({
    id: 'toolu_agent_missing_prompt',
    name: 'Agent',
    args: { subagent_type: 'Explore' }
  }, requiredByName, schemaByName);

  assert.equal(missingPrompt.ok, false);
  assert.equal(missingPrompt.action, 'rejected');
  assert.deepEqual(missingPrompt.missingKeys, ['description', 'prompt']);
});

test('tool call normalization rejects non-inferable missing and unexpected inputs', () => {
  const declarations = [
    {
      name: 'Bash',
      parametersJsonSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
        additionalProperties: false
      }
    },
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
    }
  ];
  const requiredByName = createRequiredToolLookup(declarations, 'parametersJsonSchema');
  const schemaByName = createToolSchemaLookup(declarations, 'parametersJsonSchema');

  const missing = evaluateFunctionCallInput({
    id: 'toolu_bash_missing',
    name: 'Bash',
    args: {}
  }, requiredByName, schemaByName);

  assert.equal(missing.ok, false);
  assert.equal(missing.action, 'rejected');
  assert.deepEqual(missing.diagnostic, {
    type: 'tool_call_invalid_input',
    id: 'toolu_bash_missing',
    name: 'Bash',
    missingRequired: ['command']
  });

  const unexpected = evaluateFunctionCallInput({
    id: 'toolu_write_duplicate',
    name: 'Write',
    args: { file_path: 'tmp/a.txt', content: 'ok', write_content: 'duplicate' }
  }, requiredByName, schemaByName);

  assert.equal(unexpected.ok, false);
  assert.equal(unexpected.reason, 'unexpected_input');
  assert.deepEqual(unexpected.diagnostic.unexpectedInput, ['write_content']);
  assert.equal(
    formatInvalidToolCallText([unexpected.diagnostic]),
    'Upstream returned invalid tool call input; suppressed execution for: Write unexpected input: write_content'
  );
});

test('tool call normalization derives empty TaskCreate input from adjacent assistant context only', () => {
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
  const requiredByName = createRequiredToolLookup(declarations, 'parametersJsonSchema');
  const schemaByName = createToolSchemaLookup(declarations, 'parametersJsonSchema');

  const derived = evaluateFunctionCallInput({
    id: 'toolu_task_create_empty',
    name: 'TaskCreate',
    args: {}
  }, requiredByName, schemaByName, {
    contextText: '**Developing SSH Host Persistence**\n\nPersist backend SSH host configurations and construct the API routing layer.'
  });

  assert.equal(derived.ok, true);
  assert.equal(derived.action, 'normalized');
  assert.equal(derived.reason, 'context_derived');
  assert.deepEqual(derived.normalizedKeys, ['subject', 'description']);
  assert.deepEqual(derived.input, {
    subject: 'Developing SSH Host Persistence',
    description: 'Persist backend SSH host configurations and construct the API routing layer.'
  });

  const missingContext = evaluateFunctionCallInput({
    id: 'toolu_task_create_no_context',
    name: 'TaskCreate',
    args: {}
  }, requiredByName, schemaByName);

  assert.equal(missingContext.ok, false);
  assert.equal(missingContext.action, 'rejected');
  assert.deepEqual(missingContext.missingKeys, ['subject', 'description']);
});
