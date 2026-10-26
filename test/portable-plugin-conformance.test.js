'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { inspectPortablePlugin, projectPortablePlugin } = require('../lib/native-resources/portable-plugin-conformance');
const fixture = path.resolve(__dirname, '../examples/native-plugins/aih-demo');
test('canonical portable package has explicit DeepSeek, OpenCode, Pi and AIH host projections', () => {
  const report = inspectPortablePlugin(fixture);
  assert.equal(report.pluginId, 'aih-demo');
  for (const host of ['deepseek', 'opencode', 'pi', 'aih']) {
    assert.equal(report.hosts[host].state, 'projection-ready', host);
    assert.ok(report.hosts[host].entry);
  }
});
test('host conformance fails closed when an imported host entry is missing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-portable-conformance-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(fixture, root, { recursive: true });
  const packageFile = path.join(root, 'package.json'); const pkg = JSON.parse(fs.readFileSync(packageFile));
  delete pkg.exports['./deepseek']; fs.writeFileSync(packageFile, JSON.stringify(pkg));
  assert.equal(inspectPortablePlugin(root).hosts.deepseek.state, 'projection-missing');
});
test('project emits a sanitized host projection report without secrets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-portable-project-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, 'deepseek');
  const result = projectPortablePlugin(fixture, 'deepseek', out);
  assert.equal(result.state, 'projection-ready');
  const projection = JSON.parse(fs.readFileSync(path.join(out, 'host-projection.json'), 'utf8'));
  assert.deepEqual(projection, { host: 'deepseek', pluginId: 'aih-demo', entry: './dist/hosts/deepseek.mjs', state: 'projection-ready' });
  assert.doesNotMatch(JSON.stringify(projection), /token|secret|key/i);
});
