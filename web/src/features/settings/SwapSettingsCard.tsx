import { useCallback, useEffect, useMemo, useState } from 'react';
import { InputNumber, Popconfirm, Select } from 'antd';
import { SettingRow, SettingSection } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import InlineNote from '@/components/ui/InlineNote';
import AppButton from '@/components/ui/AppButton';
import { systemAPI, type SystemSwapStatus } from '@/services/api';

const PRESETS = [
  { value: 1024, label: '1 GB' },
  { value: 2048, label: '2 GB' },
  { value: 4096, label: '4 GB' },
  { value: 8192, label: '8 GB' }
];

function formatMb(value: number): string {
  if (value >= 1024) {
    return `${(value / 1024).toFixed(value % 1024 === 0 ? 0 : 1)} GB`;
  }
  return `${value} MB`;
}

/**
 * 服务器交换空间设置。
 * 只在系统支持手动管理交换时渲染（Linux）；macOS/Windows 直接返回 null，
 * 不出现点了会失败的入口。
 */
export default function SwapSettingsCard() {
  const [status, setStatus] = useState<SystemSwapStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [sizeMb, setSizeMb] = useState<number>(2048);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await systemAPI.getSwap();
      setStatus(next);
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '读取交换空间状态失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const canChange = Boolean(status?.supported && status?.canChange);
  const activeLabel = useMemo(() => {
    if (!status) return '读取中';
    if (!status.active) return '未启用';
    return `已启用 ${formatMb(status.totalMb)}`;
  }, [status]);

  if (loadError) {
    return (
      <InlineNote tone="error" description={loadError}>
        无法读取服务器交换空间
      </InlineNote>
    );
  }
  if (!status || !status.supported) return null;

  const apply = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const next = await systemAPI.applySwap(sizeMb);
      setStatus(next);
      setFeedback({ tone: 'success', text: `已把交换空间调整为 ${formatMb(next.totalMb)}` });
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : '设置交换空间失败' });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const next = await systemAPI.removeSwap();
      setStatus(next);
      setFeedback({ tone: 'success', text: '已关闭并删除交换文件' });
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : '关闭交换空间失败' });
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingSection
      title="服务器交换空间（Swap）"
      description="内存不足时把冷页换到磁盘，降低 agy/Codex 等长任务被 OOM 终止的概率。"
      status={(
        <SettingStatusTag
          status={status.active ? 'applied' : 'unset'}
          label={activeLabel}
          compact
        />
      )}
      extra={(
        <AppButton size="small" onClick={() => { void load(); }} disabled={busy}>
          刷新
        </AppButton>
      )}
    >
      <SettingRow
        title="当前用量"
        description="来自 /proc/meminfo 与 /proc/swaps，实时反映内核交换空间。"
        persistedValue={(
          <span>
            {formatMb(status.totalMb)} 总量 · {formatMb(status.usedMb)} 已用 · {formatMb(status.freeMb)} 空闲
            {status.persisted ? ' · 已写入 /etc/fstab' : ''}
          </span>
        )}
        control={<span>{status.file || '/swapfile'}</span>}
      />

      <SettingRow
        title="目标大小"
        description="调整时会先挂载新交换文件，再撤掉旧的，避免内存瞬间不够用。"
        caveat={canChange ? undefined : (status.reason || '当前进程没有 sudo 权限，只能查看。')}
        control={(
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Select
              size="small"
              value={PRESETS.some((preset) => preset.value === sizeMb) ? sizeMb : undefined}
              placeholder="自定义"
              options={PRESETS}
              style={{ width: 96 }}
              onChange={(value) => setSizeMb(value)}
            />
            <InputNumber
              size="small"
              min={512}
              max={65536}
              step={512}
              value={sizeMb}
              addonAfter="MB"
              style={{ width: 140 }}
              onChange={(value) => setSizeMb(Number(value) || 0)}
            />
            <AppButton
              size="small"
              type="primary"
              loading={busy}
              disabled={!canChange || sizeMb < 512 || sizeMb > 65536}
              onClick={() => { void apply(); }}
            >
              应用
            </AppButton>
            <Popconfirm
              title="关闭并删除交换文件？"
              description="系统会失去这块交换空间，内存紧张时更容易被 OOM。"
              okText="确认关闭"
              cancelText="取消"
              onConfirm={() => { void remove(); }}
              disabled={!canChange || !status.active}
            >
              <AppButton size="small" danger disabled={!canChange || !status.active || busy}>
                关闭交换
              </AppButton>
            </Popconfirm>
          </div>
        )}
      />

      {feedback ? (
        <InlineNote tone={feedback.tone}>{feedback.text}</InlineNote>
      ) : null}
    </SettingSection>
  );
}