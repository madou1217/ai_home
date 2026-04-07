#!/usr/bin/env node
'use strict';

/**
 * 迁移脚本:将历史存量账号的 config.toml 从软链接转换为独立文件
 *
 * 问题背景:
 * - 旧版本将 config.toml 加入到 SESSION_STORE_ALLOWLIST 中,导致所有账号的
 *   config.toml 都是软链接到 ~/.codex/config.toml
 * - 这导致无法为不同账号配置独立的 Provider
 *
 * 修复方案:
 * 1. 检查所有 Codex 账号的 config.toml 是否是软链接
 * 2. 如果是软链接,删除它并创建独立的配置文件
 * 3. 保留用户可能手动添加的自定义配置
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// 获取真实的 HOME 目录(支持测试环境)
function getRealHome() {
  return process.env.REAL_HOME || process.env.HOME || os.homedir();
}

function getAiHomeDir() {
  const home = getRealHome();
  return path.join(home, '.ai_home');
}

function getCodexProfilesDir() {
  return path.join(getAiHomeDir(), 'profiles', 'codex');
}

function getGlobalCodexConfig() {
  const home = getRealHome();
  return path.join(home, '.codex', 'config.toml');
}

/**
 * 创建默认的 config.toml 内容
 */
function createDefaultConfig(accountId) {
  return `# Codex configuration for account ${accountId}
# This file is managed by ai-home (aih)
# Add your custom providers here
#
# Example:
# [[providers]]
# name = "my-provider"
# base_url = "https://api.example.com/v1"
# api_key_env = "MY_API_KEY"

`;
}

/**
 * 检查路径是否是软链接
 */
function isSymlink(filePath) {
  try {
    const stats = fs.lstatSync(filePath);
    return stats.isSymbolicLink();
  } catch (error) {
    return false;
  }
}

/**
 * 迁移单个账号的 config.toml
 */
function migrateAccountConfig(accountId) {
  const codexProfilesDir = getCodexProfilesDir();
  const accountConfigDir = path.join(codexProfilesDir, accountId.toString(), '.codex');
  const accountConfigPath = path.join(accountConfigDir, 'config.toml');

  // 确保账号配置目录存在
  if (!fs.existsSync(accountConfigDir)) {
    fs.mkdirSync(accountConfigDir, { recursive: true });
  }

  // 先检查是否是软链接(即使目标不存在也能检测到)
  const isLink = isSymlink(accountConfigPath);

  // 如果不是软链接
  if (!isLink) {
    // 检查文件是否存在
    if (!fs.existsSync(accountConfigPath)) {
      // 不存在,创建默认配置
      console.log(`  [创建] 账号 ${accountId}: 创建新的独立配置文件`);
      fs.writeFileSync(accountConfigPath, createDefaultConfig(accountId), 'utf8');
      return { created: true, migrated: false };
    }

    // 已经是独立文件,跳过
    console.log(`  [跳过] 账号 ${accountId}: 已经是独立配置文件`);
    return { created: false, migrated: false };
  }

  // 是软链接,需要迁移
  console.log(`  [迁移] 账号 ${accountId}: 从软链接转换为独立文件`);

  // 读取软链接指向的目标
  const linkTarget = fs.readlinkSync(accountConfigPath);
  const resolvedTarget = path.resolve(path.dirname(accountConfigPath), linkTarget);

  // 备份原软链接信息
  console.log(`    - 原软链接目标: ${resolvedTarget}`);

  // 读取全局配置内容(如果存在)
  const globalCodexConfig = getGlobalCodexConfig();
  let globalConfigContent = '';
  if (fs.existsSync(globalCodexConfig)) {
    try {
      globalConfigContent = fs.readFileSync(globalCodexConfig, 'utf8');
    } catch (error) {
      console.warn(`    - 警告: 无法读取全局配置: ${error.message}`);
    }
  }

  // 删除软链接
  fs.unlinkSync(accountConfigPath);

  // 创建独立配置文件
  let newConfigContent = createDefaultConfig(accountId);

  // 如果全局配置中有自定义 providers,保留它们
  if (globalConfigContent) {
    const providerMatches = globalConfigContent.match(/\[\[providers\]\][\s\S]*?(?=\n\[\[|$)/g);
    if (providerMatches && providerMatches.length > 0) {
      console.log(`    - 保留 ${providerMatches.length} 个自定义 provider 配置`);
      newConfigContent += '\n# 从全局配置迁移的 providers\n';
      newConfigContent += providerMatches.join('\n\n');
      newConfigContent += '\n';
    }
  }

  fs.writeFileSync(accountConfigPath, newConfigContent, 'utf8');
  console.log(`    ✓ 迁移完成`);

  return { created: false, migrated: true };
}

/**
 * 获取所有 Codex 账号 ID
 */
function getAllCodexAccounts() {
  const codexProfilesDir = getCodexProfilesDir();
  if (!fs.existsSync(codexProfilesDir)) {
    return [];
  }

  try {
    const entries = fs.readdirSync(codexProfilesDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(name => /^\d+$/.test(name)) // 只保留数字 ID
      .sort((a, b) => parseInt(a) - parseInt(b));
  } catch (error) {
    console.error(`错误: 无法读取 Codex 账号目录: ${error.message}`);
    return [];
  }
}

/**
 * 主函数
 */
function main() {
  console.log('='.repeat(60));
  console.log('Codex Config.toml 迁移脚本');
  console.log('='.repeat(60));
  console.log();

  const aiHomeDir = getAiHomeDir();

  // 检查 AI Home 目录是否存在
  if (!fs.existsSync(aiHomeDir)) {
    console.error('错误: AI Home 目录不存在:', aiHomeDir);
    process.exit(1);
  }

  // 获取所有账号
  const accounts = getAllCodexAccounts();
  if (accounts.length === 0) {
    console.log('未找到任何 Codex 账号,无需迁移。');
    return;
  }

  console.log(`找到 ${accounts.length} 个 Codex 账号: ${accounts.join(', ')}`);
  console.log();

  // 统计信息
  let stats = {
    total: accounts.length,
    created: 0,
    migrated: 0,
    skipped: 0,
    errors: 0
  };

  // 迁移每个账号
  console.log('开始迁移:');
  console.log();

  accounts.forEach(accountId => {
    try {
      const result = migrateAccountConfig(accountId);
      if (result.created) {
        stats.created++;
      } else if (result.migrated) {
        stats.migrated++;
      } else {
        stats.skipped++;
      }
    } catch (error) {
      console.error(`  [错误] 账号 ${accountId}: ${error.message}`);
      stats.errors++;
    }
  });

  // 输出统计信息
  console.log();
  console.log('='.repeat(60));
  console.log('迁移完成');
  console.log('='.repeat(60));
  console.log();
  console.log('统计信息:');
  console.log(`  - 总账号数: ${stats.total}`);
  console.log(`  - 新创建: ${stats.created}`);
  console.log(`  - 已迁移: ${stats.migrated}`);
  console.log(`  - 已跳过: ${stats.skipped}`);
  console.log(`  - 错误: ${stats.errors}`);
  console.log();

  if (stats.migrated > 0) {
    console.log('✓ 成功将 ' + stats.migrated + ' 个账号从软链接迁移为独立配置');
    console.log();
    console.log('后续步骤:');
    console.log('1. 使用 ./scripts/add-codex-provider.sh 为账号添加自定义 provider');
    console.log('2. 或手动编辑 ~/.ai_home/profiles/codex/<ID>/.codex/config.toml');
    console.log();
  }

  if (stats.errors > 0) {
    console.warn('警告: 有 ' + stats.errors + ' 个账号迁移失败,请手动检查');
    process.exit(1);
  }
}

// 运行主函数
if (require.main === module) {
  main();
}

module.exports = {
  migrateAccountConfig,
  getAllCodexAccounts
};
