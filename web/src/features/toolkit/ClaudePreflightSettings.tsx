import { message, Segmented } from 'antd';
import {
  CloseCircleOutlined,
  GlobalOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  WarningOutlined
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import type { ClaudePreflightMode } from '@/types';
import {
  describeClaudePreflightMode,
  describeClaudePreflightStatus,
  useClaudePreflight
} from './use-claude-preflight';
import './claude-preflight-settings.css';

const MODE_OPTIONS = [
  { label: '自动', value: 'auto' },
  { label: '开启', value: 'on' },
  { label: '关闭', value: 'off' }
];

/**
 * Claude Code 首屏检查（onboarding preflight）：随 Claude Code CLI 的应用高级设置
 * 统一管理，不再占用设置页。策略对所有 aih 启动的 Claude Code 会话生效。
 */
export default function ClaudePreflightSettings() {
  const preflight = useClaudePreflight({ probeOnLoad: true });
  const config = preflight.config;
  const mode: ClaudePreflightMode = config?.mode || 'auto';

  const changeMode = async (nextMode: ClaudePreflightMode) => {
    try {
      const next = await preflight.updateMode(nextMode);
      // 开启 / 自动立即探测：保存后马上给出环境结论，避免不知情地停在 403。
      if (nextMode !== 'off') {
        const probed = await preflight.probe();
        if (nextMode === 'on' && probed?.reachable === false) {
          message.warning('当前环境不可达，开启后全新 Claude 配置首次启动会停在 403');
        }
      }
      if (next.mode === 'off') message.success('已关闭 Claude 首屏检查');
    } catch (_error) {
      message.error('保存 Claude 首屏检查配置失败');
    }
  };

  const reachable = config?.reachable;
  const dotState = reachable === true ? 'ok' : reachable === false ? 'bad' : 'idle';

  return (
    <div className="aas-preflight-pane">
      <section className="aas-section">
        <div className="aas-section-head">
          <GlobalOutlined />
          <div>
            <strong>首屏检查</strong>
            <span>
              Claude Code 首次启动会请求 api.anthropic.com 与 platform.claude.com；
              网络或代理不可达时会停在 403 欢迎页，第三方 Base URL 也无法进入会话。
            </span>
          </div>
          <Segmented
            size="small"
            value={mode}
            disabled={preflight.loading || preflight.saving}
            options={MODE_OPTIONS}
            onChange={(value) => void changeMode(value as ClaudePreflightMode)}
            aria-label="首屏检查模式"
          />
        </div>
        <p className="aas-hint">{describeClaudePreflightMode(mode)}</p>
        <div className="aas-preflight-status">
          <span className="aas-preflight-dot" data-state={dotState} aria-hidden="true" />
          <span>{preflight.probing ? '正在检测当前环境…' : describeClaudePreflightStatus(config)}</span>
          {config ? (
            <span className="aas-preflight-effective">
              当前{config.effective ? '执行检查' : '跳过检查'}
            </span>
          ) : null}
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={preflight.probing}
            onClick={() => void preflight.probe()}
          >
            重新检测
          </Button>
        </div>
        {preflight.error ? (
          <div className="aas-inline-state" data-tone="error" role="alert">
            <CloseCircleOutlined />
            <span>{preflight.error}</span>
          </div>
        ) : null}
        {mode === 'on' && reachable === false ? (
          <div className="aas-inline-state" data-tone="error" role="alert">
            <WarningOutlined />
            <span>
              当前环境不可达；开启后全新 Claude 配置首次启动会 403 停在欢迎页。
              请关闭本项或为 Claude 配置代理。
            </span>
          </div>
        ) : null}
      </section>

      <section className="aas-section">
        <div className="aas-section-head aas-section-head--plain">
          <InfoCircleOutlined />
          <div>
            <strong>模式与作用范围</strong>
            <span>保存后对所有由 aih 启动的 Claude Code 会话生效；已经运行中的会话不受影响。</span>
          </div>
        </div>
        <div className="aas-preflight-modes">
          <span><code>自动</code>首次按当前网络 / 代理的探测结果决定：可达则保留检查，不可达则跳过。</span>
          <span><code>开启</code>始终保留官方检查；环境不可达时会停在 403。</span>
          <span><code>关闭</code>始终跳过官方检查，直接进入会话。</span>
        </div>
      </section>
    </div>
  );
}
