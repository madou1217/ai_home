#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_CLAUDE_MODEL = 'claude-opus-4.6-thinking';
const DEFAULT_AGY_ACCOUNT = '1';
const DEFAULT_OUTPUT_DIR = path.join('tmp', 'ai-ui-delegation');
const PROVIDERS = new Set(['claude', 'agy', 'both']);

function parseArgs(argv) {
  const options = {
    provider: 'claude',
    agyAccount: DEFAULT_AGY_ACCOUNT,
    agyContinue: false,
    agyConversation: '',
    agyPrintTimeout: '3m',
    claudeModel: DEFAULT_CLAUDE_MODEL,
    outputDir: DEFAULT_OUTPUT_DIR,
    scope: 'AI Home WebUI Accounts Dashboard DesignSystem',
    dryRun: false,
    printPrompt: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--provider') {
      if (!next || !PROVIDERS.has(next)) {
        throw new Error('--provider must be one of: claude, agy, both');
      }
      options.provider = next;
      index += 1;
      continue;
    }
    if (arg === '--agy-account') {
      if (!next) throw new Error('--agy-account requires a value');
      options.agyAccount = next;
      index += 1;
      continue;
    }
    if (arg === '--agy-continue') {
      options.agyContinue = true;
      continue;
    }
    if (arg === '--agy-conversation') {
      if (!next) throw new Error('--agy-conversation requires a value');
      options.agyConversation = next;
      index += 1;
      continue;
    }
    if (arg === '--agy-print-timeout') {
      if (!next) throw new Error('--agy-print-timeout requires a value');
      options.agyPrintTimeout = next;
      index += 1;
      continue;
    }
    if (arg === '--model') {
      if (!next) throw new Error('--model requires a value');
      options.claudeModel = next;
      index += 1;
      continue;
    }
    if (arg === '--output-dir') {
      if (!next) throw new Error('--output-dir requires a value');
      options.outputDir = next;
      index += 1;
      continue;
    }
    if (arg === '--scope') {
      if (!next) throw new Error('--scope requires a value');
      options.scope = next;
      index += 1;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--print-prompt') {
      options.printPrompt = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function showHelp(log = console.log) {
  log(`AI Home UI delegate

Usage:
  npm run ui:delegate -- --provider claude
  npm run ui:delegate -- --provider agy --agy-account 1
  npm run ui:delegate -- --provider both --scope "Accounts mobile redesign"

Options:
  --provider <claude|agy|both>  Choose the design delegate.
  --model <name>                Claude model, default ${DEFAULT_CLAUDE_MODEL}.
  --agy-account <id>            Agy account id, default ${DEFAULT_AGY_ACCOUNT}.
  --agy-continue                Continue the most recent agy conversation.
  --agy-conversation <id>       Resume an agy conversation by id.
  --agy-print-timeout <value>   Agy print timeout, default 3m.
  --scope <text>                Design scope to pass into the prompt.
  --output-dir <path>           Output directory, default ${DEFAULT_OUTPUT_DIR}.
  --dry-run                     Print commands without executing them.
  --print-prompt                Print prompt text before execution.
`);
}

function buildClaudePrompt(scope) {
  return [
    '你是 AI Home 项目的产品设计负责人和前端架构师。',
    '请基于真实工程约束输出严格 JSON，不要 markdown。',
    '技术栈：React/Vite/AntD WebUI，入口 /ui。',
    '工程约束：必须使用 Tailwind CSS v4 减少样式样板，必须使用 animate.css 作为入场/强调动效库。',
    '品牌标识：com.clawdcodex.ai_home；命令统一使用 aih。',
    '用户要求：现代产品级，不是旧后台，不是黑绿终端，不是白底 SaaS，不是紫色 AI 模板。',
    'PC 与 H5 必须是两套交互规范和组件结构，不允许只是 CSS 缩放。',
    '规范结构必须正式覆盖：设计原则、设计语言、配色方案、字体、间距、按钮、输入框、选择器、反馈、动效、UX、UE、PC、H5、验收。',
    '配色与组件参考方向：Zeeklog Palette Browser 的色彩关系，Tailwind Slate/Blue/Teal scales，shadcn/ui + Radix 的组件分层。',
    '设计方向：Graphite Command Workspace，参考 Linear/Raycast/Vercel/Warp 的成熟工具质感，但不要照抄；偏中性石墨、清晰层级、克制高质量动效、真实产品工作台。',
    'PC：固定工作区导航、命令条、密集但有呼吸感的数据区、清晰一级/二级/危险/图标按钮。',
    'H5：按 App 标准重构，底部导航、安全区、拇指区主动作、单列卡片、底部 Sheet、44px 触控、无横向滚动。',
    `本次范围：${scope}`,
    '输出 JSON 字段：aestheticName, dfiiScore, productThesis, desktopSpec[], mobileSpec[], designTokens{colors,typography,spacing,motion}, accountsRedesign{desktop,mobile,components[]}, dashboardRedesign{desktop,mobile,components[]}, designSystemPage{sections[],componentLab[]}, interactionRules[], acceptanceChecks[], implementationWarnings[]。',
    '要求实际可落 React/CSS，不要泛泛建议。'
  ].join('');
}

function buildAgyPrompt(scope) {
  return [
    '你是 AI Home H5 App 设计审查员。',
    '你同时必须以产品经理、设计负责人、前端架构师的视角审查页面。',
    '项目是 React/Vite/AntD WebUI，移动端必须不是 PC 缩小版。',
    '工程约束：必须考虑 Tailwind CSS v4、animate.css、AntD token、真实 H5 触控组件规范。',
    '请只输出严格 JSON。',
    '必须批判并重构当前设计规范页：解决布局窒息、label 粗糙、配色无体系、按钮大小不一致、控件状态不完整、移动端像 PC 缩小版的问题。',
    '视觉方向：Graphite Command Workspace + Crisp Product Manual，成熟工具产品，不要旧后台、不要黑绿终端、不要紫色 AI 模板。',
    `本次范围：${scope}`,
    'JSON 字段：productCritique[], designDirection, colorSystem{palette[],usageRules[]}, typographyRules[], layoutRules{desktop[],mobile[]}, componentSpecs{buttons[],inputs[],selectors[],feedback[],motion[]}, designSystemPage{informationArchitecture[],hero,sections[],componentLab[],mobileLayout}, antiPatterns[], acceptanceChecks[]。',
    '重点：iOS Safari/Android Chrome、100dvh、safe-area、visualViewport 键盘适配、44px 触控、底部 Tab、Bottom Sheet、单列账号卡片、危险动作确认、防重复点击、无横向滚动。',
    '必须覆盖按钮、输入框、选择器、反馈、动效、空/错/加载状态在 H5 上的独立规范。',
    '不要推荐紫色 AI 模板，不要泛泛建议。'
  ].join('');
}

function buildRuns(options) {
  const runs = [];
  if (options.provider === 'claude' || options.provider === 'both') {
    runs.push({
      provider: 'claude',
      fileLabel: 'claude-ui-plan',
      command: 'aih',
      args: [
        'claude',
        '-p',
        buildClaudePrompt(options.scope),
        '--model',
        options.claudeModel,
        '--no-session-persistence'
      ]
    });
  }
  if (options.provider === 'agy' || options.provider === 'both') {
    const agyResumeArgs = options.agyConversation
      ? ['--conversation', options.agyConversation]
      : options.agyContinue
        ? ['--continue']
        : [];
    runs.push({
      provider: 'agy',
      fileLabel: 'agy-mobile-plan',
      command: 'aih',
      args: [
        'agy',
        options.agyAccount,
        ...agyResumeArgs,
        '-p',
        buildAgyPrompt(options.scope),
        '--print-timeout',
        options.agyPrintTimeout
      ]
    });
  }
  return runs;
}

function stripAnsi(value) {
  return String(value || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[()][A-Za-z0-9]/g, '')
    .replace(/\u000f/g, '');
}

function extractJson(stdout) {
  const clean = stripAnsi(stdout);
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('delegate output did not contain a JSON object');
  }
  const rawJson = clean.slice(start, end + 1);
  return JSON.parse(rawJson);
}

function toOutputFile(outputDir, fileLabel, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(outputDir, `${stamp}-${fileLabel}.json`);
}

function writeRawOutput(outputDir, fileLabel, provider, output, now = new Date()) {
  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const outputFile = path.join(outputDir, `${stamp}-${fileLabel}.raw.txt`);
  fs.writeFileSync(outputFile, [
    `provider=${provider}`,
    `createdAt=${now.toISOString()}`,
    '',
    stripAnsi(output)
  ].join('\n'), 'utf8');
  return outputFile;
}

function runDelegate(run, options) {
  if (options.printPrompt) {
    console.log(`\n[${run.provider}] ${run.args[2] || run.args[3] || ''}\n`);
  }
  if (options.dryRun) {
    return {
      provider: run.provider,
      command: [run.command, ...run.args].join(' '),
      outputFile: null
    };
  }

  const child = spawnSync(run.command, run.args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 10
  });
  const combinedOutput = `${child.stdout || ''}\n${child.stderr || ''}`;
  if (child.error) {
    throw child.error;
  }
  if (child.status !== 0) {
    const rawOutputFile = writeRawOutput(options.outputDir, run.fileLabel, run.provider, combinedOutput);
    throw new Error(`${run.command} ${run.args[0]} exited with ${child.status}; raw output: ${rawOutputFile}`);
  }

  let json;
  try {
    json = extractJson(combinedOutput);
  } catch (error) {
    const rawOutputFile = writeRawOutput(options.outputDir, run.fileLabel, run.provider, combinedOutput);
    throw new Error(`${error.message}; raw output: ${rawOutputFile}`);
  }
  fs.mkdirSync(options.outputDir, { recursive: true });
  const outputFile = toOutputFile(options.outputDir, run.fileLabel);
  fs.writeFileSync(outputFile, `${JSON.stringify({
    provider: run.provider,
    command: [run.command, ...run.args.filter((arg) => arg !== buildClaudePrompt(options.scope) && arg !== buildAgyPrompt(options.scope))],
    scope: options.scope,
    createdAt: new Date().toISOString(),
    result: json
  }, null, 2)}\n`);

  return {
    provider: run.provider,
    outputFile
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    showHelp();
    return [];
  }
  const runs = buildRuns(options);
  const results = runs.map((run) => runDelegate(run, options));
  results.forEach((result) => {
    if (result.outputFile) {
      console.log(`[ui-delegate] ${result.provider} -> ${result.outputFile}`);
    } else {
      console.log(`[ui-delegate] ${result.provider} dry-run: ${result.command}`);
    }
  });
  return results;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[ui-delegate] ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildAgyPrompt,
  buildClaudePrompt,
  buildRuns,
  extractJson,
  main,
  parseArgs,
  stripAnsi,
  writeRawOutput,
  toOutputFile
};
