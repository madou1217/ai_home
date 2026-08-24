'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODEL_USAGE_PAGE = path.join(__dirname, '../web/src/pages/ModelUsage.tsx');
const MODEL_USAGE_STYLES = path.join(__dirname, '../web/src/pages/ModelUsage.css');

test('date-range changes enter loading state before replacing the active query', () => {
  const source = fs.readFileSync(MODEL_USAGE_PAGE, 'utf8');

  assert.match(
    source,
    /const handleRangeModeChange = \(value: RangeMode\) => \{\s*beginUsageTransition\(\);\s*setRangeMode\(value\)/
  );
  assert.match(
    source,
    /const handleRangeChange = [\s\S]*?beginUsageTransition\(\);\s*setRangeMode\('custom'\)/
  );
  assert.match(source, /aria-busy=\{loading\}/);
  assert.match(source, /正在切换数据范围/);
});

test('dashboard refresh keeps the previous snapshot until replacement data arrives', () => {
  const source = fs.readFileSync(MODEL_USAGE_PAGE, 'utf8');
  const loadStart = source.indexOf('const loadUsage = useCallback');
  const loadEnd = source.indexOf('\n  useEffect(() => {', loadStart);
  const loadSource = source.slice(loadStart, loadEnd);

  assert.ok(loadStart >= 0 && loadEnd > loadStart);
  assert.doesNotMatch(loadSource, /setStats\(emptyStats\)/);
  assert.doesNotMatch(loadSource, /setModels\(\[\]\)/);
  assert.doesNotMatch(loadSource, /setSessions\(\[\]\)/);
  assert.doesNotMatch(loadSource, /setTrend\(emptyTrend\)/);
  assert.match(source, /setHasDashboardSnapshot\(true\)/);
  assert.match(source, /切换失败，仍显示上一次成功快照/);
});

test('loading transition is visible, restrained and respects reduced motion', () => {
  const styles = fs.readFileSync(MODEL_USAGE_STYLES, 'utf8');

  assert.match(styles, /\.usage-query-progress--visible/);
  assert.match(styles, /@keyframes usage-query-progress-sweep/);
  assert.match(styles, /\.usage-dashboard-body--refreshing \.usage-kpi-rail/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(styles, /border-left/);
});
