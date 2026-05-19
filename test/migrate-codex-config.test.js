'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { migrateAccountConfig, getAllCodexAccounts } = require('../scripts/migrate-codex-config');

test('migrate-codex-config', async (t) => {
  let tempDir;
  let originalEnv;

  t.beforeEach(() => {
    // 创建临时测试目录
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-migrate-'));

    // 保存原始环境变量
    originalEnv = {
      REAL_HOME: process.env.REAL_HOME,
      HOME: process.env.HOME
    };

    // 设置测试环境
    process.env.REAL_HOME = tempDir;
    process.env.HOME = tempDir;
  });

  t.afterEach(() => {
    // 恢复环境变量
    if (originalEnv.REAL_HOME) {
      process.env.REAL_HOME = originalEnv.REAL_HOME;
    } else {
      delete process.env.REAL_HOME;
    }
    if (originalEnv.HOME) {
      process.env.HOME = originalEnv.HOME;
    }

    // 清理临时目录
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  await t.test('应该为不存在 config.toml 的账号创建默认配置', () => {
    // 准备:创建账号目录但不创建 config.toml
    const accountId = '10';
    const codexDir = path.join(tempDir, '.ai_home', 'profiles', 'codex', accountId, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });

    // 执行迁移
    const result = migrateAccountConfig(accountId);

    // 验证
    assert.strictEqual(result.created, true);
    assert.strictEqual(result.migrated, false);

    const configPath = path.join(codexDir, 'config.toml');
    assert.ok(fs.existsSync(configPath), 'config.toml 应该被创建');

    const content = fs.readFileSync(configPath, 'utf8');
    assert.ok(content.includes('# Codex configuration for account 10'));
    assert.ok(content.includes('# This file is managed by ai-home (aih)'));
  });

  await t.test('应该跳过已经是独立文件的 config.toml', () => {
    // 准备:创建已经存在的独立 config.toml
    const accountId = '11';
    const codexDir = path.join(tempDir, '.ai_home', 'profiles', 'codex', accountId, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });

    const configPath = path.join(codexDir, 'config.toml');
    const existingContent = '# Existing config\n';
    fs.writeFileSync(configPath, existingContent, 'utf8');

    // 执行迁移
    const result = migrateAccountConfig(accountId);

    // 验证
    assert.strictEqual(result.created, false);
    assert.strictEqual(result.migrated, false);

    // 内容应该保持不变
    const content = fs.readFileSync(configPath, 'utf8');
    assert.strictEqual(content, existingContent);
  });

  await t.test('应该将软链接的 config.toml 转换为独立文件', () => {
    // 准备:创建全局 config.toml 和软链接
    const accountId = '12';
    const globalCodexDir = path.join(tempDir, '.codex');
    const accountCodexDir = path.join(tempDir, '.ai_home', 'profiles', 'codex', accountId, '.codex');

    fs.mkdirSync(globalCodexDir, { recursive: true });
    fs.mkdirSync(accountCodexDir, { recursive: true });

    const globalConfigPath = path.join(globalCodexDir, 'config.toml');
    const accountConfigPath = path.join(accountCodexDir, 'config.toml');

    // 创建全局配置
    const globalContent = `# Global config
model_provider = "aih"

[[providers]]
name = "custom-provider"
base_url = "https://example.com/v1"
api_key_env = "MY_API_KEY"
`;
    fs.writeFileSync(globalConfigPath, globalContent, 'utf8');

    // 创建软链接
    fs.symlinkSync(globalConfigPath, accountConfigPath, 'file');

    // 验证软链接确实存在
    const stats = fs.lstatSync(accountConfigPath);
    assert.ok(stats.isSymbolicLink(), '应该是软链接');

    // 执行迁移
    const result = migrateAccountConfig(accountId);

    // 验证
    assert.strictEqual(result.created, false);
    assert.strictEqual(result.migrated, true);

    // 验证不再是软链接
    const newStats = fs.lstatSync(accountConfigPath);
    assert.ok(!newStats.isSymbolicLink(), '应该不再是软链接');
    assert.ok(newStats.isFile(), '应该是普通文件');

    // 验证内容
    const newContent = fs.readFileSync(accountConfigPath, 'utf8');
    assert.ok(newContent.includes('# Codex configuration for account 12'));
    assert.ok(newContent.includes('custom-provider'), '应该保留全局配置中的 providers');
    assert.ok(newContent.includes('https://example.com/v1'));
  });

  await t.test('getAllCodexAccounts 应该返回所有数字 ID 的账号', () => {
    // 准备:创建多个账号目录
    const codexProfilesDir = path.join(tempDir, '.ai_home', 'profiles', 'codex');
    fs.mkdirSync(codexProfilesDir, { recursive: true });

    // 创建有效账号
    ['1', '10', '99', '100'].forEach(id => {
      fs.mkdirSync(path.join(codexProfilesDir, id), { recursive: true });
    });

    // 创建无效账号(非数字)
    ['abc', 'test', '.hidden'].forEach(name => {
      fs.mkdirSync(path.join(codexProfilesDir, name), { recursive: true });
    });

    // 创建文件(应该被过滤)
    fs.writeFileSync(path.join(codexProfilesDir, 'file.txt'), 'test');

    // 执行
    const accounts = getAllCodexAccounts();

    // 验证
    assert.deepStrictEqual(accounts, ['1', '10', '99', '100']);
  });

  await t.test('应该保留全局配置中的多个 providers', () => {
    const accountId = '13';
    const globalCodexDir = path.join(tempDir, '.codex');
    const accountCodexDir = path.join(tempDir, '.ai_home', 'profiles', 'codex', accountId, '.codex');

    fs.mkdirSync(globalCodexDir, { recursive: true });
    fs.mkdirSync(accountCodexDir, { recursive: true });

    const globalConfigPath = path.join(globalCodexDir, 'config.toml');
    const accountConfigPath = path.join(accountCodexDir, 'config.toml');

    // 创建带有多个 providers 的全局配置
    const globalContent = `model_provider = "aih"

[[providers]]
name = "provider1"
base_url = "https://api1.example.com/v1"
api_key_env = "KEY1"

[[providers]]
name = "provider2"
base_url = "https://api2.example.com/v1"
api_key_env = "KEY2"
`;
    fs.writeFileSync(globalConfigPath, globalContent, 'utf8');
    fs.symlinkSync(globalConfigPath, accountConfigPath, 'file');

    // 执行迁移
    const result = migrateAccountConfig(accountId);

    // 验证
    assert.strictEqual(result.migrated, true);

    const newContent = fs.readFileSync(accountConfigPath, 'utf8');
    assert.ok(newContent.includes('provider1'));
    assert.ok(newContent.includes('provider2'));
    assert.ok(newContent.includes('https://api1.example.com/v1'));
    assert.ok(newContent.includes('https://api2.example.com/v1'));
  });

  await t.test('当全局配置不存在时应该创建空的默认配置', () => {
    const accountId = '14';
    const accountCodexDir = path.join(tempDir, '.ai_home', 'profiles', 'codex', accountId, '.codex');
    const globalCodexDir = path.join(tempDir, '.codex');

    fs.mkdirSync(accountCodexDir, { recursive: true });
    fs.mkdirSync(globalCodexDir, { recursive: true });

    const accountConfigPath = path.join(accountCodexDir, 'config.toml');
    const globalConfigPath = path.join(globalCodexDir, 'config.toml');

    // 创建指向不存在文件的软链接
    // 注意:这里我们创建一个假的目标路径
    fs.symlinkSync(globalConfigPath, accountConfigPath, 'file');

    // 执行迁移(全局配置不存在)
    const result = migrateAccountConfig(accountId);

    // 验证
    assert.strictEqual(result.migrated, true);

    const content = fs.readFileSync(accountConfigPath, 'utf8');
    assert.ok(content.includes('# Codex configuration for account 14'));
    assert.ok(!content.includes('provider1')); // 不应该有任何 providers
  });

  await t.test('应该处理不存在配置目录的情况', () => {
    const accountId = '15';

    // 不创建任何目录,直接执行迁移
    const result = migrateAccountConfig(accountId);

    // 验证
    assert.strictEqual(result.created, true);

    // 验证目录和文件被创建
    const codexDir = path.join(tempDir, '.ai_home', 'profiles', 'codex', accountId, '.codex');
    const configPath = path.join(codexDir, 'config.toml');

    assert.ok(fs.existsSync(codexDir));
    assert.ok(fs.existsSync(configPath));
  });
});
