import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidElement } from 'react';
import type { ReactElement, ReactNode } from 'react';
import AppErrorBoundary from './AppErrorBoundary';

test('AppErrorBoundary 初始无错误状态，直接渲染子内容', () => {
  const boundary = new AppErrorBoundary({ children: 'page content' });
  assert.equal(boundary.state.error, null);
  assert.equal(boundary.render(), 'page content');
});

test('AppErrorBoundary getDerivedStateFromError 捕获错误进入兜底态', () => {
  const error = new Error('boom');
  assert.deepEqual(AppErrorBoundary.getDerivedStateFromError(error), { error });
});

test('AppErrorBoundary 出错后渲染紧凑兜底而非子内容', () => {
  const boundary = new AppErrorBoundary({ children: 'page content' });
  boundary.state = { error: new Error('boom') };
  const fallback = boundary.render() as ReactElement<{ children: ReactNode[] }>;
  assert.ok(isValidElement(fallback));
  assert.equal(fallback.type, 'div');
  const [title, detail, action] = fallback.props.children as Array<ReactElement<{ children: ReactNode }>>;
  assert.equal(title.props.children, '页面渲染出错');
  assert.equal(detail.props.children, 'boom');
  assert.equal(action.props.children, '重新加载');
});
