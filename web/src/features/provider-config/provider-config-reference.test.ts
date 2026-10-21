import { describe, expect, test } from 'bun:test';
import type { ProviderConfigSchema, ProviderConfigSchemaField } from '@/types';
import {
  buildProviderConfigReferenceRows,
  countReferenceIssues,
  countUnrecordedKeys,
  describeReferenceIssue,
  filterReferenceRows,
  findReferenceField
} from './provider-config-reference';

const CONFIG = [
  'model = "gpt-5"',
  'approval_policy = "never"',
  'legacy_key = true',
  '',
  '[mcp_servers.demo]',
  'command = "node"'
].join('\n');

function field(partial: Partial<ProviderConfigSchemaField> & { path: string }): ProviderConfigSchemaField {
  return {
    type: 'string',
    description: '说明',
    ...partial
  };
}

const SCHEMA: ProviderConfigSchema = {
  id: 'codex.config',
  title: 'config.toml',
  source: 'OpenAI 文档',
  sourceUrl: 'https://example.com/config',
  docsUrl: 'https://example.com/config',
  verifiedAt: '2026-10-20',
  verifiedCliVersion: '0.163.0',
  sensitive: false,
  fieldCount: 4,
  fields: [
    field({ path: 'model', description: '默认模型', cliSample: 'codex --model <model>', cliFlag: '--model' }),
    field({ path: 'approval_policy', type: 'enum', deprecated: true, options: ['never', 'on-request'] }),
    field({ path: 'legacy_key', removedIn: '0.150.0' }),
    field({ path: 'mcp_servers.demo.command' })
  ],
  compatibilityWarnings: []
};

describe('buildProviderConfigReferenceRows', () => {
  test('only lists keys that actually appear in the file, in file order', () => {
    const rows = buildProviderConfigReferenceRows(SCHEMA, CONFIG, 'toml', '0.163.0');
    expect(rows.map((row) => row.path)).toEqual([
      'model',
      'approval_policy',
      'legacy_key',
      'mcp_servers.demo.command'
    ]);
    expect(rows.map((row) => row.line)).toEqual([1, 2, 3, 6]);
  });

  test('marks unknown, deprecated and version-removed keys as issues', () => {
    const rows = buildProviderConfigReferenceRows(SCHEMA, 'unknown_key = 1\n', 'toml', '0.163.0');
    expect(rows[0].issue).toBe('unknown');
    expect(rows[0].field).toBeNull();
    expect(rows[0].messages.length).toBeGreaterThan(0);

    const deprecated = buildProviderConfigReferenceRows(SCHEMA, 'approval_policy = "never"\n', 'toml', '0.163.0');
    expect(deprecated[0].issue).toBe('deprecated');

    const removed = buildProviderConfigReferenceRows(SCHEMA, 'legacy_key = true\n', 'toml', '0.163.0');
    expect(removed[0].issue).toBe('unsupported');
  });

  test('keeps the CLI equivalent sample from the schema field', () => {
    const rows = buildProviderConfigReferenceRows(SCHEMA, 'model = "gpt-5"\n', 'toml', '0.163.0');
    expect(rows[0].field?.cliSample).toBe('codex --model <model>');
  });

  test('returns nothing for an empty file', () => {
    expect(buildProviderConfigReferenceRows(SCHEMA, '', 'toml', '0.163.0')).toEqual([]);
  });

  test('works without a schema: every key is reported as unknown', () => {
    const rows = buildProviderConfigReferenceRows(null, '{"a": 1}', 'json', '');
    expect(rows.map((row) => row.issue)).toEqual(['unknown']);
  });
});

describe('findReferenceField', () => {
  const withPlaceholders: ProviderConfigSchemaField[] = [
    field({ path: 'model' }),
    field({ path: 'model_providers.<id>.name' }),
    field({ path: 'projects.<path>.trust_level' })
  ];

  test('prefers the exact / parent match before placeholder matching', () => {
    expect(findReferenceField(withPlaceholders, 'model')?.path).toBe('model');
  });

  test('matches schema placeholders for real configuration keys', () => {
    expect(findReferenceField(withPlaceholders, 'model_providers.aih_server.name')?.path)
      .toBe('model_providers.<id>.name');
    expect(findReferenceField(withPlaceholders, 'projects./Users/me/repo.trust_level')?.path)
      .toBe('projects.<path>.trust_level');
  });

  test('a placeholder may consume multiple segments when the key contains dots', () => {
    expect(findReferenceField(withPlaceholders, 'projects./Users/me/my.repo.trust_level')?.path)
      .toBe('projects.<path>.trust_level');
  });

  test('returns null when nothing can explain the key', () => {
    expect(findReferenceField(withPlaceholders, 'totally_unknown_key')).toBeNull();
    expect(findReferenceField(undefined, 'model')).toBeNull();
  });
});

describe('describeReferenceIssue', () => {
  test('keeps the schema compatibility message when the current CLI is too old', () => {
    const result = describeReferenceIssue(field({ path: 'new_key', since: '0.200.0' }), '0.163.0');
    expect(result.issue).toBe('unsupported');
    expect(result.messages.join('')).toContain('0.200.0');
  });
});

describe('countReferenceIssues / filterReferenceRows', () => {
  test('counts only deprecated and version-removed rows as issues', () => {
    const rows = buildProviderConfigReferenceRows(SCHEMA, CONFIG, 'toml', '0.163.0');
    expect(countReferenceIssues(rows)).toBe(2);
  });

  test('counts unrecorded keys separately from issues', () => {
    const rows = buildProviderConfigReferenceRows(SCHEMA, 'brand_new_key = 1\n', 'toml', '0.163.0');
    expect(countReferenceIssues(rows)).toBe(0);
    expect(countUnrecordedKeys(rows)).toBe(1);
  });

  test('filters by key path and field description', () => {
    const rows = buildProviderConfigReferenceRows(SCHEMA, CONFIG, 'toml', '0.163.0');
    expect(filterReferenceRows(rows, 'MODEL').map((row) => row.path)).toEqual(['model']);
    expect(filterReferenceRows(rows, '默认模型').map((row) => row.path)).toEqual(['model']);
    expect(filterReferenceRows(rows, '   ')).toHaveLength(rows.length);
  });
});
