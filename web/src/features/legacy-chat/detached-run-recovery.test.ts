import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveApiProxyRunSnapshot } from './detached-run-snapshot';

test('resolveApiProxyRunSnapshot 只对 api-proxy run 返回已累积内容快照', () => {
  assert.equal(
    resolveApiProxyRunSnapshot({ mode: 'api-proxy', contentSnapshot: '半截回复' }),
    '半截回复',
  );
  assert.equal(
    resolveApiProxyRunSnapshot({ mode: 'api-proxy', contentSnapshot: '' }),
    '',
  );
});

test('resolveApiProxyRunSnapshot 不对 native run 输出快照(避免误触发 native 恢复逻辑)', () => {
  assert.equal(
    resolveApiProxyRunSnapshot({ mode: 'native-session', contentSnapshot: '不该出现' }),
    '',
  );
  assert.equal(resolveApiProxyRunSnapshot({}), '');
  assert.equal(resolveApiProxyRunSnapshot(null), '');
  assert.equal(resolveApiProxyRunSnapshot(undefined), '');
});
