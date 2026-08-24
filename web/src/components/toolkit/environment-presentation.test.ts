import assert from 'node:assert/strict';
import test from 'node:test';

import { getEnvironmentCategoryLabel } from './environment-presentation.ts';

test('运行环境内部分类统一映射为中文标签', () => {
  assert.deepEqual(
    [
      'version-manager',
      'package-manager',
      'environment-manager',
      'virtual-environment',
      'runtime'
    ].map(getEnvironmentCategoryLabel),
    ['版本管理器', '包管理器', '环境管理器', '虚拟环境', '运行时']
  );
});

test('未知运行环境分类保留原值，空值显示未分类', () => {
  assert.equal(getEnvironmentCategoryLabel('custom-tool'), 'custom-tool');
  assert.equal(getEnvironmentCategoryLabel(''), '未分类');
});
