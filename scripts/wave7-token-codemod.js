/* Wave 7 codemod: 旧 token 迁移收尾。
 * 范围: chat.module.css 拆分后的 web/src/components/chat/ 全部 module.css
 * 以及残留旧引用的 .tsx 内联样式;映射与 wave6-token-codemod.js 完全一致(直接复用)。
 * 用法: node scripts/wave7-token-codemod.js [--apply]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { migrateSource, walk, ROOT } = require('./wave6-token-codemod');

const CHAT_DIR = path.join(ROOT, 'components', 'chat');
const TSX_FILES = [
  'features/accounts/AuthProgressModal.tsx',
  'pages/SshHostsPanel.tsx',
  'pages/ModelUsage.tsx',
  'pages/AccountsGoPreview.tsx',
  'pages/FabricServerSetup.tsx',
  'pages/FabricWebrtcDiagnostics.tsx',
];

const apply = process.argv.includes('--apply');
let total = 0;
const report = new Map();

function merge(r) {
  for (const [k, v] of r) report.set(k, (report.get(k) || 0) + v);
}

for (const file of walk(CHAT_DIR)) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, 'utf8');
  const { out, total: n, report: r } = migrateSource(src, path.normalize(rel));
  if (apply && out !== src) fs.writeFileSync(file, out);
  total += n;
  merge(r);
}

for (const rel of TSX_FILES) {
  const file = path.join(ROOT, rel);
  const src = fs.readFileSync(file, 'utf8');
  const { out, total: n, report: r } = migrateSource(src, path.normalize(rel));
  if (apply && out !== src) fs.writeFileSync(file, out);
  total += n;
  merge(r);
}

console.log(`${apply ? 'applied' : 'dry-run'}: ${total} replacements`);
for (const [k, n] of [...report.entries()].sort()) console.log(`${String(n).padStart(4)}  ${k}`);
