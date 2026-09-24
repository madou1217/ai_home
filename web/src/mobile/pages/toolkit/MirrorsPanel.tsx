import { useState } from 'react';
import { CheckCircleOutlined, CloudSyncOutlined, ThunderboltOutlined } from '@ant-design/icons';
import {
  mirrorApplicableRegion,
  mirrorLatencyLabel,
  useMirrorManager,
  type MirrorKind,
  type MirrorLatencyResult
} from '@/components/toolkit/use-mirror-manager';
import MobileBoot from '@/mobile/MobileBoot';
import { DetailSheet, EmptySignal, HudChips, HudSection, KeyValue, MonoList, SwipeRow, TelemetryGrid, TelemetryTile } from '@/mobile/ui';
import type { HudTone } from '@/mobile/ui';
import type { MirrorPreset } from '@/types';
import GuidedCommand from './GuidedCommand';
import { ActionButton, InlineError, PanelToolbar, StatusText } from './toolkit-parts';
import styles from '../MobileToolkit.module.css';

const KIND_ITEMS: Array<{ key: MirrorKind; label: string }> = [
  { key: 'npm', label: 'npm / pnpm / yarn' },
  { key: 'pip', label: 'Python pip' }
];

function latencyTone(result: MirrorLatencyResult | undefined): HudTone {
  if (!result || result.state === 'idle') return 'muted';
  if (result.state === 'loading') return 'info';
  return result.state === 'success' ? 'ok' : 'err';
}

/** 软件源与镜像：npm / pip 当前配置、镜像预设、HTTP TTFB 实测、写入配置与平台命令指南。 */
export default function MirrorsPanel() {
  const {
    data,
    kind,
    setKind,
    setSelectedId,
    loading,
    error,
    setError,
    settingUrl,
    latencies,
    fetchMirrors,
    mirrorData,
    presets,
    selectedPreset,
    guideTasks,
    testLatency,
    setMirror,
    currentValue,
    selectedLatency
  } = useMirrorManager();
  const [sheetOpen, setSheetOpen] = useState(false);

  const openPreset = (preset: MirrorPreset) => {
    setSelectedId(preset.id);
    setSheetOpen(true);
  };

  if (loading && !data) return <MobileBoot label="READING MIRRORS" />;

  return (
    <>
      <PanelToolbar status="列表选择来源，详情查看配置、延迟与命令" refreshLabel="重新读取" refreshing={loading} onRefresh={fetchMirrors} />
      {error ? <InlineError title="镜像操作未完成" detail={error} onDismiss={() => setError('')} /> : null}

      {mirrorData ? (
        <>
          <HudChips ariaLabel="包管理器" value={kind} onChange={(value) => setKind(value as MirrorKind)} items={KIND_ITEMS} />

          <TelemetryGrid>
            <TelemetryTile
              wide
              label="当前配置"
              value={<span className={styles.tileMono}>{currentValue}</span>}
              tone={mirrorData.current ? 'info' : 'warn'}
              led
              sub={`${kind === 'npm' ? 'npm registry' : 'pip global.index-url'} 当前读取值`}
            />
          </TelemetryGrid>

          <HudSection title={`${kind} 镜像`} code="MIRROR" count={presets.length}>
            {presets.length ? (
              <MonoList ariaLabel={`${kind} 镜像列表`}>
                {presets.map((preset) => {
                  const result = latencies[preset.url];
                  return (
                    <SwipeRow
                      key={preset.id}
                      onTap={() => openPreset(preset)}
                      ariaLabel={`${preset.name} 详情`}
                      actions={[
                        {
                          key: 'ping',
                          label: '测速',
                          icon: <ThunderboltOutlined />,
                          disabled: result?.state === 'loading',
                          onAction: () => void testLatency(preset)
                        },
                        {
                          key: 'apply',
                          label: preset.active ? '当前' : '写入',
                          icon: <CloudSyncOutlined />,
                          tone: 'primary',
                          disabled: Boolean(preset.active) || settingUrl === preset.url,
                          onAction: () => void setMirror(preset)
                        }
                      ]}
                    >
                      <span className="mhud-row__main">
                        <span className="mhud-row__title">{preset.name}</span>
                        <span className="mhud-row__meta">{preset.url}</span>
                      </span>
                      <span className="mhud-row__side">
                        {preset.active ? <StatusText tone="ok">当前配置</StatusText> : null}
                        {result && result.state !== 'idle'
                          ? <StatusText tone={latencyTone(result)} live={result.state === 'loading'}>{mirrorLatencyLabel(result)}</StatusText>
                          : <span className="mhud-row__meta">{mirrorApplicableRegion(preset)}</span>}
                      </span>
                    </SwipeRow>
                  );
                })}
              </MonoList>
            ) : (
              <EmptySignal description="没有可选择的镜像源" />
            )}
          </HudSection>
        </>
      ) : null}

      <DetailSheet
        open={sheetOpen && Boolean(selectedPreset)}
        onClose={() => setSheetOpen(false)}
        code={`SOURCE // ${kind.toUpperCase()}`}
        title={selectedPreset?.name || '镜像'}
        footer={selectedPreset ? (
          <>
            <ActionButton
              icon={<ThunderboltOutlined />}
              label="测试 HTTP TTFB"
              loading={latencies[selectedPreset.url]?.state === 'loading'}
              onClick={() => void testLatency(selectedPreset)}
            />
            <ActionButton
              icon={selectedPreset.active ? <CheckCircleOutlined /> : <CloudSyncOutlined />}
              label={selectedPreset.active ? '当前配置' : '写入当前源'}
              tone="primary"
              disabled={Boolean(selectedPreset.active)}
              loading={settingUrl === selectedPreset.url}
              onClick={() => void setMirror(selectedPreset)}
            />
          </>
        ) : null}
      >
        {selectedPreset ? (
          <div className={styles.sheetStack}>
            <KeyValue
              rows={[
                { key: 'url', label: 'URL', value: selectedPreset.url },
                { key: 'source', label: '来源', value: selectedPreset.official ? '官方主源' : '第三方镜像', mono: false },
                { key: 'region', label: '适用区域', value: mirrorApplicableRegion(selectedPreset), mono: false },
                { key: 'desc', label: '说明', value: selectedPreset.desc || '服务端未提供说明', mono: false },
                {
                  key: 'latency',
                  label: '实测',
                  value: <StatusText tone={latencyTone(selectedLatency)} live={selectedLatency?.state === 'loading'}>{mirrorLatencyLabel(selectedLatency)}</StatusText>
                }
              ]}
            />
            {selectedLatency?.state === 'error' && selectedLatency.error ? <p className={styles.hint}>{selectedLatency.error}</p> : null}
            <p className={styles.prose}>Direct HTTP HEAD 首字节时间；只把 2xx/3xx 判为成功，不代表下载吞吐量。</p>
            <HudSection title={`${selectedPreset.name} 使用指南`} code="GUIDE" count={guideTasks.length}>
              <GuidedCommand tasks={guideTasks} emptyText="服务端没有返回该镜像的命令指南。" />
            </HudSection>
          </div>
        ) : null}
      </DetailSheet>
    </>
  );
}
