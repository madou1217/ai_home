import { Button } from 'antd';
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface AppErrorBoundaryProps {
  children?: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

// 全局渲染兜底：任一页面 render 抛错时拦住整树卸载（白屏），
// 降级为紧凑的行内错误态 + 重新加载入口。
export default class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[AppErrorBoundary] 页面渲染异常', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{
        padding: 24,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 12,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>页面渲染出错</div>
        <div style={{ fontSize: 12, opacity: 0.65, wordBreak: 'break-all' }}>
          {String(error.message || error)}
        </div>
        <Button size="small" onClick={() => window.location.reload()}>
          重新加载
        </Button>
      </div>
    );
  }
}
