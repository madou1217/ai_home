import { useCallback, useEffect, useRef, useState } from 'react';
import { Input } from 'antd';
import { ClearOutlined, ReloadOutlined, SaveOutlined, SyncOutlined } from '@ant-design/icons';
import type { ManagedToolItem } from '@/types';
import { DetailSheet } from '@/mobile/ui';
import { useManagedToolConfig } from '@/components/toolkit/use-managed-tool-config';
import { ActionButton, InlineError, Note } from './toolkit-parts';

interface ManagedToolConfigSheetProps {
  /** 要编辑的工具；为空即关闭。 */
  tool: ManagedToolItem | null;
  onClose: () => void;
  /** 保存/重启成功后回调（调用方刷新工具列表）。 */
  onSaved?: () => void | Promise<void>;
}

/**
 * 受管工具配置编辑（移动端）：轻量文本框（移动端不加载 Monaco），
 * 校验/保存/重启流程与桌面共用 useManagedToolConfig。
 */
export default function ManagedToolConfigSheet({ tool, onClose, onSaved }: ManagedToolConfigSheetProps) {
  const { configData, content, setContent, loading, saving, error, reload, save } = useManagedToolConfig(tool, onSaved);
  const [initial, setInitial] = useState('');
  const syncedRevision = useRef('');
  const dirty = content !== initial;
  const canSave = dirty || configData?.exists === false;

  // 首次拿到内容时记录基线（用于「撤销改动」与"是否有未保存改动"）。
  useEffect(() => {
    const revision = configData ? `${tool?.id}:${configData.revision}` : '';
    if (!revision) { syncedRevision.current = ''; return; }
    if (syncedRevision.current === revision) return;
    syncedRevision.current = revision;
    setInitial(configData?.content || '');
  }, [configData, tool?.id]);

  const reset = useCallback(() => setContent(initial), [initial, setContent]);

  return (
    <DetailSheet
      open={Boolean(tool)}
      onClose={onClose}
      code="CONFIG"
      title={tool ? `${tool.name} 配置` : '配置'}
      maxHeight="92dvh"
      footer={tool ? (
        <>
          <ActionButton
            icon={<ReloadOutlined />}
            label="重读"
            onClick={() => void reload()}
            disabled={saving}
            loading={loading}
          />
          {dirty ? (
            <ActionButton icon={<ClearOutlined />} label="撤销" onClick={reset} disabled={saving} />
          ) : null}
          {tool.service?.canRestart ? (
            <ActionButton
              icon={<SyncOutlined />}
              label="保存并重启"
              onClick={() => void save(true)}
              disabled={saving || loading || !configData}
              loading={saving}
            />
          ) : null}
          <ActionButton
            icon={<SaveOutlined />}
            label={configData?.exists === false ? '创建配置' : dirty ? '保存' : '已保存'}
            tone="primary"
            onClick={() => void save()}
            disabled={saving || loading || !configData || !canSave}
            loading={saving}
          />
        </>
      ) : null}
    >
      {loading ? <Note tone="info">正在读取配置…</Note> : null}
      {error ? <InlineError title="配置操作失败" detail={error} onRetry={() => void reload()} retrying={loading} /> : null}
      {configData && !configData.writable ? (
        <Note tone="warn">当前配置不可写（或需要系统授权），保存时可能被拒绝。</Note>
      ) : null}
      {tool?.requiresElevation || configData?.requiresElevation ? (
        <Note tone="info">该配置保存需要系统授权，接口不会返回绝对路径。</Note>
      ) : null}
      {configData?.exists === false ? <Note>尚无配置文件，保存后会创建。</Note> : null}
      {tool?.configNote ? <Note>{tool.configNote}</Note> : null}
      {configData && !loading ? (
        <Input.TextArea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          autoSize={{ minRows: 12, maxRows: 26 }}
          spellCheck={false}
          aria-label={`${tool?.name || '工具'} 配置内容`}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
        />
      ) : null}
      {configData ? (
        <Note tone="info">
          {configData.configName || tool?.configName || '配置文件'} · 格式 {configData.configFormat || 'text'}
          {dirty ? ' · 有未保存改动' : ''}
        </Note>
      ) : null}
    </DetailSheet>
  );
}
