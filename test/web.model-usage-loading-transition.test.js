'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODEL_USAGE_PAGE = path.join(__dirname, '../web/src/pages/ModelUsage.tsx');
const MODEL_USAGE_STYLES = path.join(__dirname, '../web/src/pages/ModelUsage.css');

test('date-range changes enter loading state without rendering a separate status strip', () => {
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
  assert.doesNotMatch(source, /usage-query-progress|dashboardStatusText|正在切换数据范围/);
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
  assert.match(source, /setDashboardLoadError\(errorMessage\)/);
});

test('loading transition keeps the prior snapshot fade without a redundant progress bar', () => {
  const styles = fs.readFileSync(MODEL_USAGE_STYLES, 'utf8');

  assert.doesNotMatch(styles, /\.usage-query-progress|usage-query-progress-sweep/);
  assert.match(styles, /\.usage-dashboard-body--refreshing \.usage-kpi-rail/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(styles, /border-left/);
});
