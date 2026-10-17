'use strict';

// `aih server config list` 的渲染层：纯函数（不读文件、不写 stdout），
// 输入「已保存配置 + 选项」，输出字符串。描述符表是唯一事实源。
const { DEFAULT_SERVER_CONFIG } = require('./server-config-store');
const { SERVER_CONFIG_FIELDS, SERVER_CONFIG_GROUP_ORDER } = require('./server-config-schema');

const STORE_LABEL = 'app-state 键 `config:server`';
const APPLIES_LABEL = {
  'serve-arg': 'serve 参数（重启后下发）',
  'process-env': '启动时写进程环境（重启后生效）',
  runtime: '运行期直接读配置（重启后生效）'
};

// 终端显示宽度：CJK / 全角字符占两列，其余一列。表格对齐必须按显示宽度算，
// 否则中文列会错位（用 length 是最常见的 bug）。
function displayWidth(text) {
  let width = 0;
  for (const char of String(text == null ? '' : text)) {
    const code = char.codePointAt(0);
    const wide = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1f64f);
    width += wide ? 2 : 1;
  }
  return width;
}

function padEndDisplay(text, width) {
  const value = String(text == null ? '' : text);
  const pad = Math.max(0, width - displayWidth(value));
  return value + ' '.repeat(pad);
}

// 按「ASCII 词 / 单个 CJK 字符」切 token 后再折行：ASCII 单词不会被从中间劈开
// （`client key` 被切成 `cl` + `ient key` 是 naive 逐字符折行的典型 bug）。
function tokenizeForWrap(text) {
  const tokens = [];
  let buffer = '';
  for (const char of String(text == null ? '' : text)) {
    if (/[\x20-\x7e]/.test(char)) {
      buffer += char;
      continue;
    }
    if (buffer) {
      tokens.push(buffer);
      buffer = '';
    }
    tokens.push(char);
  }
  if (buffer) tokens.push(buffer);
  return tokens;
}

// 行首禁止出现的标点：宁可让上一行超一两列，也不要把标点单独甩到行首。
const NO_LINE_START = new Set([...'/.,;:!?)]}%', ...'，。；：！？、）】」》”’']);

function wrapDisplay(text, width) {
  const limit = Math.max(12, Number(width) || 80);
  const lines = [];
  let line = '';
  for (const token of tokenizeForWrap(text)) {
    if (displayWidth(line) + displayWidth(token) <= limit) {
      line += token;
      continue;
    }
    if (line.trim() && !NO_LINE_START.has(token)) {
      lines.push(line.replace(/\s+$/, ''));
      line = '';
    }
    if (displayWidth(token) > limit) {
      let chunk = '';
      for (const char of token) {
        if (displayWidth(chunk) + displayWidth(char) > limit) {
          lines.push(chunk);
          chunk = char;
          continue;
        }
        chunk += char;
      }
      line = chunk;
      continue;
    }
    line = token.trimStart();
  }
  if (line.trim() || lines.length === 0) lines.push(line.replace(/\s+$/, ''));
  return lines;
}

function humanizeDuration(ms) {
  const value = Number(ms) || 0;
  if (value <= 0) return '';
  if (value % 3600000 === 0) return `${value / 3600000}h`;
  if (value % 60000 === 0) return `${value / 60000}m`;
  if (value % 1000 === 0) return `${value / 1000}s`;
  return `${value}ms`;
}

function formatValue(field, value) {
  if (field && field.secret) return String(value || '').trim() ? 'configured' : 'missing';
  if (Array.isArray(value)) return value.length > 0 ? value.join(',') : '-';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (field && field.type === 'duration') {
    const ms = Number(value) || 0;
    if (ms <= 0) return '-';
    return `${ms} (${humanizeDuration(ms)})`;
  }
  if (typeof value === 'number') {
    if (value === 0 && field && field.zeroMeans) return `0 (=${field.zeroMeans})`;
    return String(value);
  }
  const text = String(value == null ? '' : value).trim();
  return text || '-';
}

function defaultOf(field) {
  if (field && field.default !== undefined) return field.default;
  return DEFAULT_SERVER_CONFIG[field.key];
}

function currentOf(config, field) {
  const source = config && typeof config === 'object' ? config : {};
  if (Object.prototype.hasOwnProperty.call(source, field.key)) return source[field.key];
  return defaultOf(field);
}

function matchesFilter(field, filter) {
  const needle = String(filter || '').trim().toLowerCase();
  if (!needle) return true;
  return [field.key, field.flag, field.summary, field.group]
    .some((text) => String(text || '').toLowerCase().includes(needle));
}

function buildRows(config, fields) {
  return fields.map((field) => ({
    field,
    key: field.key,
    flag: field.flag,
    type: field.type,
    defaultValue: formatValue(field, defaultOf(field)),
    currentValue: formatValue(field, currentOf(config, field))
  }));
}

function paint(text, code, color) {
  return color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function renderTable(rows, options) {
  const color = options.color === true;
  const keyWidth = Math.max(...rows.map((row) => displayWidth(row.key)), 3);
  const flagWidth = Math.max(...rows.map((row) => displayWidth(row.flag)), 8);
  const typeWidth = Math.max(...rows.map((row) => displayWidth(row.type)), 4);
  const defaultWidth = Math.max(...rows.map((row) => displayWidth(row.defaultValue)), 7);
  const header = [
    padEndDisplay('KEY', keyWidth),
    padEndDisplay('SET FLAG', flagWidth),
    padEndDisplay('TYPE', typeWidth),
    padEndDisplay('DEFAULT', defaultWidth),
    'CURRENT'
  ].join('  ');
  return [paint(header, '90', color)].concat(rows.map((row) => [
    padEndDisplay(row.key, keyWidth),
    padEndDisplay(row.flag, flagWidth),
    padEndDisplay(row.type, typeWidth),
    padEndDisplay(row.defaultValue, defaultWidth),
    row.currentValue
  ].join('  ')));
}

function renderSummaryLines(rows, options) {
  const color = options.color === true;
  const indentWidth = 4;
  const keyWidth = Math.max(...rows.map((row) => displayWidth(row.key)), 3);
  const wrapWidth = Math.max(40, (options.columns || 100) - indentWidth - keyWidth - 2);
  const lines = [];
  for (const row of rows) {
    const head = ' '.repeat(indentWidth + keyWidth + 2);
    const body = wrapDisplay(row.field.summary, wrapWidth);
    body.forEach((text, index) => {
      lines.push(index === 0
        ? `${' '.repeat(indentWidth)}${paint(padEndDisplay(row.key, keyWidth), '36', color)}  ${text}`
        : `${head}${text}`);
    });
    if (row.field.clearFlag) {
      lines.push(`${head}${paint(`清除：${row.field.clearFlag}`, '90', color)}`);
    }
    if (options.verbose) {
      const env = row.field.env && row.field.env.length > 0 ? row.field.env.join(', ') : '-';
      lines.push(`${head}${paint(`env ${env} · ${APPLIES_LABEL[row.field.applies] || row.field.applies}`, '90', color)}`);
    }
  }
  return lines;
}

function renderOneLine(rows, options) {
  const color = options.color === true;
  return rows.map((row) => {
    const env = row.field.env && row.field.env.length > 0 ? row.field.env.join(',') : '-';
    const parts = [
      row.key,
      row.flag,
      row.type,
      `default=${row.defaultValue}`,
      `current=${row.currentValue}`,
      `env=${env}`,
      `clear=${row.field.clearFlag || '-'}`,
      row.field.applies,
      row.field.summary
    ];
    return parts.map((part, index) => (index === 0 ? paint(part, '36', color) : part)).join(' | ');
  });
}

function renderServerConfigList(config, options = {}) {
  const fields = SERVER_CONFIG_FIELDS.filter((field) => matchesFilter(field, options.filter));
  if (options.json) {
    return JSON.stringify({
      store: 'config:server',
      count: fields.length,
      fields: fields.map((field) => ({
        key: field.key,
        group: field.group,
        flag: field.flag,
        clearFlag: field.clearFlag || '',
        type: field.type,
        values: field.values || [],
        default: defaultOf(field),
        current: field.secret
          ? (String(currentOf(config, field) || '').trim() ? 'configured' : 'missing')
          : currentOf(config, field),
        env: field.env || [],
        applies: field.applies,
        secret: field.secret === true,
        summary: field.summary
      }))
    }, null, 2);
  }

  const rows = buildRows(config, fields);
  if (rows.length === 0) {
    return `[aih] server config: no option matches ${JSON.stringify(String(options.filter || ''))}`;
  }

  const color = options.color === true;
  const header = [
    paint('[aih]', '36', color) + ` server config · ${fields.length} 个可设置项 · 存储在 ${STORE_LABEL}`,
    paint('      current 列是已保存配置（secret 打码）；设置后需 `aih server restart` 生效。', '90', color)
  ];
  const footer = [
    paint('  说明：直接 `aih server config` 看当前值；`--one-line` 一行一项（便于 grep）；`--json` 给脚本用。', '90', color),
    paint('        env 是部署 fallback，config 显式设置时优先。', '90', color)
  ];

  if (options.oneLine) return header.concat(renderOneLine(rows, options), footer).join('\n');

  const lines = header.slice();
  for (const group of SERVER_CONFIG_GROUP_ORDER) {
    const groupRows = rows.filter((row) => row.field.group === group);
    if (groupRows.length === 0) continue;
    lines.push('');
    lines.push(paint(`  ${group}`, '1', color));
    lines.push(...renderTable(groupRows, options).map((line) => `    ${line}`));
    lines.push(...renderSummaryLines(groupRows, options));
  }
  lines.push('');
  lines.push(...footer);
  return lines.join('\n');
}

module.exports = {
  displayWidth,
  formatValue,
  humanizeDuration,
  renderServerConfigList
};

