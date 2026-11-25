import { useCallback, useEffect, useState } from 'react';
import { Segmented, Spin, Typography } from 'antd';
import { ApiOutlined } from '@ant-design/icons';

import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import { configAPI } from '@/services/api';
import type { ServerConfig } from '@/types';

type MCPBridgeSharing = NonNullable<ServerConfig['mcpBridgeSharing']>;

interface SharingMode {
  value: MCPBridgeSharing;
  label: string;
  description: string;
}

const SHARING_MODES: SharingMode[] = [
  {
    value: 'global',
    label: '全局共享',
    description: '所有工作区共用一个 MCP 桥 daemon，按会话 token 路由；最省内存，默认模式。'
  },
  {
    value: 'workspace',
    label: '按工作区',
    description: '每个工作区一个 daemon，工作区之间隔离更强，内存随工作区数量增长。'
  },
  {
    value: 'off',
    label: '每会话',
    description: '每个会话一个完整桥进程，隔离最强、内存占用最高；用于回退或排查。'
  }
];

function normalizeMode(value: string | undefined): MCPBridgeSharing {
  if (value === 'workspace' || value === 'off') return value;
  return 'global';
}

/**
 * MCP 共享桥设置：服务器级三档（global / workspace / off）。
 * 只在 Codex 的应用高级设置里暴露，写入 config:server.mcpBridgeSharing。
 */
export default function MCPBridgeSettings() {
  const [mode, setMode] = useState<MCPBridgeSharing>('global');
  const [savedMode, setSavedMode] = useState<MCPBridgeSharing>('global');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setFeedback('');
    configAPI.getServer({ signal: controller.signal })
      .then((server) => {
        if (controller.signal.aborted) return;
        const next = normalizeMode(server.mcpBridgeSharing);
        setMode(next);
        setSavedMode(next);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : '读取 MCP 共享桥设置失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setError('');
    setFeedback('');
    try {
      const saved = await configAPI.updateServer({ mcpBridgeSharing: mode });
      const next = normalizeMode(saved.mcpBridgeSharing);
      setMode(next);
      setSavedMode(next);
      setFeedback('已保存；新启动的工作区会话使用新的共享模式，已运行的会话不变。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存 MCP 共享桥设置失败');
    } finally {
      setSaving(false);
    }
  }, [mode]);

  const activeMode = SHARING_MODES.find((item) => item.value === mode) ?? SHARING_MODES[0];
  const savedLabel = SHARING_MODES.find((item) => item.value === savedMode)?.label ?? savedMode;

  return (
    <section className="aas-section" aria-labelledby="mcp-bridge-title">
      <div className="aas-section-head">
        <ApiOutlined />
        <div>
          <strong id="mcp-bridge-title">MCP 共享桥</strong>
          <span>服务器级设置，控制工作区会话的 MCP 桥进程复用方式；不改变 MCP 工具语义。</span>
        </div>
      </div>

      {loading ? (
        <div className="aas-loading"><Spin tip="正在读取 MCP 共享桥设置" /></div>
      ) : (
        <>
          <Segmented
            block
            value={mode}
            disabled={saving}
            options={SHARING_MODES.map((item) => ({ value: item.value, label: item.label }))}
            onChange={(value) => {
              setMode(value as MCPBridgeSharing);
              setFeedback('');
              setError('');
            }}
          />
          <Typography.Text type="secondary">{activeMode.description}</Typography.Text>

          <div className="aas-code-line">
            <span>当前生效：{savedLabel}</span>
            <Button
              type="primary"
              loading={saving}
              disabled={saving || mode === savedMode}
              onClick={() => void save()}
            >
              保存
            </Button>
          </div>

          <InlineNote tone="info">
            Windows 当前回退为每会话一个桥；切换只影响新会话。
          </InlineNote>
          {feedback ? <InlineNote tone="success">{feedback}</InlineNote> : null}
          {error ? <InlineNote tone="error">{error}</InlineNote> : null}
        </>
      )}
    </section>
  );
}
