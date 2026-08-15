import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Empty, message, Segmented, Spin, Tag, Tooltip } from 'antd';
import {
  CheckCircleOutlined,
  ReloadOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { toolkitAPI } from '@/services/api';
import type { MirrorGuide, MirrorPreset, MirrorsResponse } from '@/types';
import GuidedCommandPanel, { type GuidedCommandTask } from './GuidedCommandPanel';
import ToolkitStatusTrack from './ToolkitStatusTrack';

type MirrorKind = 'npm' | 'pip';

interface LatencyResult {
  state: 'idle' | 'loading' | 'success' | 'error';
  latencyMs?: number;
  statusCode?: number | null;
  error?: string;
}

function buildMirrorTasks(guide: MirrorGuide | undefined, preset: MirrorPreset) {
  return (guide?.commands || []).map<GuidedCommandTask>((command, index) => {
    const generated = command.cmd.replace(/<package>/gi, '{{package}}');
    const needsPackage = generated.includes('{{package}}');
    return {
      id: `${preset.id}-guide-${index}`,
      label: command.label,
      command: generated,
      category: /写入|配置|set\s/i.test(command.label) ? 'configure' : 'use',
      platform: command.platform,
      parameters: needsPackage
        ? [{ key: 'package', label: '包名', placeholder: '例如 typescript 或 requests' }]
        : undefined
    };
  });
}

function latencyLabel(result: LatencyResult | undefined) {
  if (!result || result.state === 'idle') return '未实测';
  if (result.state === 'loading') return '测试中';
  if (result.state === 'error') return '不可达';
  return `TTFB ${result.latencyMs} ms${result.statusCode ? ` · HTTP ${result.statusCode}` : ''}`;
}

function applicableRegion(preset: MirrorPreset) {
  const label = String(preset.speed || '').trim();
  if (/国内/.test(label)) return '中国大陆';
  if (/全球/.test(label)) return '全球';
  return label || '未标注';
}

export default function MirrorManagerPanel() {
  const [data, setData] = useState<MirrorsResponse | null>(null);
  const [kind, setKind] = useState<MirrorKind>('npm');
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [settingUrl, setSettingUrl] = useState('');
  const [latencies, setLatencies] = useState<Record<string, LatencyResult>>({});

  const fetchMirrors = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await toolkitAPI.getMirrors();
      if (!response.ok) throw new Error('镜像接口未返回可用结果');
      setData(response);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : '读取镜像源失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMirrors();
  }, [fetchMirrors]);

  const mirrorData = data?.[kind];
  const presets = mirrorData?.presets || [];

  useEffect(() => {
    setSelectedId((current) => {
      if (presets.some((preset) => preset.id === current)) return current;
      return presets.find((preset) => preset.active)?.id || presets[0]?.id || '';
    });
  }, [presets]);

  const selectedPreset = presets.find((preset) => preset.id === selectedId) || presets[0];
  const guideTasks = useMemo(
    () => selectedPreset ? buildMirrorTasks(selectedPreset.guides, selectedPreset) : [],
    [selectedPreset]
  );

  const testLatency = async (preset: MirrorPreset) => {
    setLatencies((current) => ({ ...current, [preset.url]: { state: 'loading' } }));
    try {
      const response = await toolkitAPI.pingMirror(preset.url);
      setLatencies((current) => ({
        ...current,
        [preset.url]: response.ok
          ? { state: 'success', latencyMs: response.latencyMs, statusCode: response.statusCode }
          : { state: 'error', statusCode: response.statusCode, error: response.error || '端点未返回 2xx/3xx' }
      }));
    } catch (requestError: unknown) {
      setLatencies((current) => ({
        ...current,
        [preset.url]: {
          state: 'error',
          error: requestError instanceof Error ? requestError.message : '请求失败'
        }
      }));
    }
  };

  const setMirror = async (preset: MirrorPreset) => {
    setSettingUrl(preset.url);
    setError('');
    try {
      const response = await toolkitAPI.setMirror(kind, preset.url);
      if (!response.ok) throw new Error(response.error || '配置写入失败');
      await fetchMirrors();
      message.success(`${preset.name} 已写入 ${kind} 配置`);
    } catch (requestError: unknown) {
      setError(requestError instanceof Error ? requestError.message : '切换镜像源失败');
    } finally {
      setSettingUrl('');
    }
  };

  const currentValue = mirrorData?.current || '未读取到显式配置';
  const selectedLatency = selectedPreset ? latencies[selectedPreset.url] : undefined;

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

      {error && <Alert type="error" showIcon message="镜像操作未完成" description={error} closable onClose={() => setError('')} />}
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
                          <Tag color={result.state === 'success' ? 'success' : result.state === 'error' ? 'error' : 'processing'}>
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
