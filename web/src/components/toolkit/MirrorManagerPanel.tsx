import { Empty, Segmented, Spin, Tag, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  CloseOutlined,
  ReloadOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import GuidedCommandPanel from './GuidedCommandPanel';
import ToolkitStatusTrack from './ToolkitStatusTrack';
import {
  mirrorApplicableRegion as applicableRegion,
  mirrorLatencyLabel as latencyLabel,
  useMirrorManager,
  type MirrorKind
} from './use-mirror-manager';

export default function MirrorManagerPanel() {
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

  return (
    <section className="toolkit-page toolkit-domain-panel" aria-labelledby="toolkit-mirror-title">
      <header className="toolkit-panel-header">
        <div>
          <div className="toolkit-panel-kicker">PACKAGE SOURCE CONTROL</div>
          <h2 id="toolkit-mirror-title">软件源与镜像</h2>
          <p>列表负责选择来源，详情区只呈现当前镜像的配置、连通延迟和平台命令。</p>
        </div>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={fetchMirrors}>重新读取</Button>
      </header>

      {error && (
        <InlineNote
          tone="error"
          description={error}
          className="toolkit-note-spaced"
          action={<Button type="text" size="small" icon={<CloseOutlined />} aria-label="关闭" onClick={() => setError('')} />}
        >
          镜像操作未完成
        </InlineNote>
      )}
      {loading && !data ? (
        <div className="toolkit-loading"><Spin size="large" tip="正在读取 npm 与 pip 配置" /></div>
      ) : mirrorData ? (
        <>
          <ToolkitStatusTrack
            ariaLabel={`${kind} 镜像状态轨道`}
            items={[
              {
                label: '实测',
                value: selectedPreset ? latencyLabel(selectedLatency) : '未选择镜像',
                detail: 'Direct HTTP HEAD 首字节时间；只把 2xx/3xx 判为成功，不代表下载吞吐量',
                tone: selectedLatency?.state === 'success' ? 'success' : selectedLatency?.state === 'error' ? 'danger' : 'neutral'
              },
              {
                label: '配置',
                value: currentValue,
                detail: `${kind === 'npm' ? 'npm registry' : 'pip global.index-url'} 当前读取值`,
                tone: mirrorData.current ? 'info' : 'warning'
              },
              {
                label: '指南',
                value: `${selectedPreset?.guides?.commands.length || 0} 条跨平台命令`,
                detail: '服务端按所选镜像填充 URL 与主机名；缺失时不生成可复制命令',
                tone: 'neutral'
              }
            ]}
          />

          <div className="toolkit-runtime-switch">
            <Segmented
              value={kind}
              onChange={(value) => setKind(value as MirrorKind)}
              options={[
                { label: 'npm / pnpm / yarn', value: 'npm' },
                { label: 'Python pip', value: 'pip' }
              ]}
            />
          </div>

          <div className="toolkit-mirror-workbench">
            <div className="toolkit-mirror-index" role="group" aria-label={`${kind} 镜像列表`}>
              {presets.map((preset) => {
                const result = latencies[preset.url];
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className="toolkit-mirror-option"
                    data-active={preset.id === selectedPreset?.id || undefined}
                    aria-pressed={preset.id === selectedPreset?.id}
                    onClick={() => setSelectedId(preset.id)}
                  >
                    <span className="toolkit-mirror-option-main">
                      <strong>{preset.name}</strong>
                      <small>{preset.url}</small>
                    </span>
                    <span className="toolkit-mirror-option-meta">
                      {preset.active && <Tag color="success"><CheckCircleOutlined /> 当前配置</Tag>}
                      <Tag>{`适用区域：${applicableRegion(preset)}`}</Tag>
                      {result?.state !== 'idle' && result && (
                        <Tooltip title={result.error}>
                          <Tag
                            color={result.state === 'success' ? 'success' : result.state === 'error' ? 'error' : 'processing'}
                            className="toolkit-status-tag"
                          >
                            <span
                              className={`hud-led ${result.state === 'success' ? 'hud-led--ok' : result.state === 'error' ? 'hud-led--err' : 'hud-led--info hud-led--live'}`}
                              aria-hidden="true"
                            />
                            {latencyLabel(result)}
                          </Tag>
                        </Tooltip>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="toolkit-mirror-detail">
              {selectedPreset ? (
                <>
                  <div className="toolkit-detail-heading">
                    <div>
                      <span>SELECTED SOURCE</span>
                      <h3>{selectedPreset.name}</h3>
                    </div>
                    <div className="toolkit-detail-actions">
                      <Tooltip title="发送一次 Direct HTTP HEAD 请求并记录 TTFB 与状态码">
                        <Button
                          icon={<ThunderboltOutlined />}
                          loading={latencies[selectedPreset.url]?.state === 'loading'}
                          onClick={() => testLatency(selectedPreset)}
                        >
                          测试 HTTP TTFB
                        </Button>
                      </Tooltip>
                      <Button
                        type="primary"
                        disabled={Boolean(selectedPreset.active)}
                        loading={settingUrl === selectedPreset.url}
                        onClick={() => setMirror(selectedPreset)}
                      >
                        {selectedPreset.active ? '当前配置' : '写入当前源'}
                      </Button>
                    </div>
                  </div>
                  <dl className="toolkit-inspection-list">
                    <div><dt>URL</dt><dd><code>{selectedPreset.url}</code></dd></div>
                    <div><dt>来源</dt><dd>{selectedPreset.official ? '官方主源' : '第三方镜像'}</dd></div>
                    <div><dt>适用区域</dt><dd>{applicableRegion(selectedPreset)}</dd></div>
                    <div><dt>说明</dt><dd>{selectedPreset.desc || '服务端未提供说明'}</dd></div>
                  </dl>
                  <GuidedCommandPanel
                    tasks={guideTasks}
                    title={`${selectedPreset.name} 使用指南`}
                    emptyText="服务端没有返回该镜像的命令指南。"
                  />
                </>
              ) : <Empty description="没有可选择的镜像源" />}
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}
