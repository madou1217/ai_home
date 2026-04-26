const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const file = '/Users/model/projects/feature/ai_home/cli/src/screens/REPL.tsx';
const screenDir = path.dirname(file);
const text = fs.readFileSync(file, 'utf8');
const specs = [...text.matchAll(/^import\s+(?:type\s+)?(?:[^'"\n]+?\s+from\s+)?['"]([^'"]+)['"]/gm)]
  .map(m => m[1])
  .filter(s => s.startsWith('.') || s.startsWith('src/'));

for (const spec of [...new Set(specs)]) {
  const target = spec.startsWith('.')
    ? pathToFileURL(path.resolve(screenDir, spec)).href
    : spec;
  const script =
    `try { ` +
    `await Promise.race([` +
    `import(${JSON.stringify(target)}), ` +
    `new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))` +
    `]); ` +
    `console.log('OK ${spec}'); ` +
    `} catch (e) { ` +
    `console.log('ERR ${spec} :: ' + ((e && e.message) || e)); ` +
    `}`;
  const result = spawnSync('bun', ['-e', script], {
    cwd: '/Users/model/projects/feature/ai_home/cli',
    encoding: 'utf8',
    timeout: 5000,
  });
  process.stdout.write((result.stdout || '') + (result.stderr || ''));
  if (result.error) {
    process.stdout.write(`SPAWN_ERR ${spec} :: ${result.error.message}\n`);
  }
}
