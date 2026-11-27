import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveListTablePagination } from './list-table-pagination.ts';

test('默认客户端分页：页大小与页数按下取整', () => {
  assert.deepEqual(resolveListTablePagination(25, 12, 1), { pageSize: 12, page: 1 });
  assert.deepEqual(resolveListTablePagination(25, 12, 3), { pageSize: 12, page: 3 });
});

test('超出最后一页收敛到最后一页', () => {
  assert.deepEqual(resolveListTablePagination(25, 12, 9), { pageSize: 12, page: 3 });
});

test('空列表仍然只有一页', () => {
  assert.deepEqual(resolveListTablePagination(0, 12, 5), { pageSize: 12, page: 1 });
  assert.deepEqual(resolveListTablePagination(-10, 12, 1), { pageSize: 12, page: 1 });
});

test('非法页大小回落到 1，非法页码回落到 1', () => {
  assert.deepEqual(resolveListTablePagination(3, 0, 1), { pageSize: 1, page: 1 });
  assert.deepEqual(resolveListTablePagination(3, -5, 1), { pageSize: 1, page: 1 });
  assert.deepEqual(resolveListTablePagination(25, 12, 0), { pageSize: 12, page: 1 });
  assert.deepEqual(resolveListTablePagination(25, 12, Number.NaN), { pageSize: 12, page: 1 });
});

test('服务端分页：total 与当前页来自接口', () => {
  assert.deepEqual(resolveListTablePagination(100, 20, 2), { pageSize: 20, page: 2 });
  assert.deepEqual(resolveListTablePagination(100, 20, 6), { pageSize: 20, page: 5 });
});
