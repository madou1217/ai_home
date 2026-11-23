import { memo, useState } from 'react';
import { message, Tag, Tooltip } from 'antd';
import {
  ArrowRightOutlined,
  CheckOutlined,
  CompassOutlined,
  CopyOutlined,
  FolderOutlined,
  MessageOutlined,
  SwapOutlined
} from '@ant-design/icons';
import ProviderIcon from '@/components/chat/ProviderIcon';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import { writeClipboardText } from '@/utils/clipboard';
import {
  describeErrorPipeline,
  extractProjectBasename,
  formatRecentErrorMessage,
  formatSessionShortId,
  getRecentErrorProvider,
  resolveFriendlyAccountDisplay,
  type DashboardRecentError
} from '@/features/dashboard/dashboard-presentation';
import type { ManagementAccount, Provider } from '@/types';

export interface DashboardRecentErrorsProps {
  errors: DashboardRecentError[];
  accountByRef: Map<string, ManagementAccount>;
  onJumpToChat: (options: { projectPath?: string; sessionId?: string }) => void;
}

/**
 * 网关最近错误列表：拆离自 Dashboard.tsx，保持复制、链路追踪与直达会话能力。
 */
export const DashboardRecentErrors = memo(function DashboardRecentErrors({
  errors,
  accountByRef,
  onJumpToChat
}: DashboardRecentErrorsProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const rows = errors.slice(0, 8).map((item, index) => ({
    ...item,
    __key: `${item.at || 'unknown'}-${index}`
  }));

  if (rows.length === 0) return null;

  const copyErrorText = async (text: string, key: string) => {
    try {
      await writeClipboardText(text);
      setCopiedKey(key);
      message.success('错误详情已复制');
      setTimeout(() => {
        setCopiedKey((curr) => (curr === key ? null : curr));
      }, 2000);
    } catch {
      message.error('复制失败，请手动复制');
    }
  };

  return (
    <section className="dash-errors-section" aria-label="最近错误">
      <div className="dash-section-head">
        <div className="dash-block-title">最近错误</div>
        <SettingStatusTag status="error" label={`${rows.length} 条`} compact live="off" />
      </div>
      <div className="dash-error-list">
        {rows.map((item) => {
          const provider = getRecentErrorProvider(item);
          const account = item.accountRef ? accountByRef.get(item.accountRef) : undefined;
          const friendlyAccount = resolveFriendlyAccountDisplay(item, account);
          const projectBasename = extractProjectBasename(item.projectPath, item.projectDirName);
          const sessionShortId = formatSessionShortId(item.sessionId);
          const errorText = formatRecentErrorMessage(item);
          const isCopied = copiedKey === item.__key;

          const {
            sourceProtocolLabel,
            targetProviderLabel,
            isCrossRoute,
            displayRequestedModel,
            displayEffectiveModel,
            isAlias,
            showPipeline
          } = describeErrorPipeline(item);

          return (
            <article className="dash-error-item hud-panel hud-panel--sm" key={item.__key}>
              <div className="dash-error-top">
                <div className="dash-error-account-info">
                  {provider ? <ProviderIcon provider={provider as Provider} size={16} /> : null}
                  <span className="dash-error-account-label" title={friendlyAccount}>
                    {friendlyAccount}
                  </span>
                </div>
                <div className="dash-error-meta-right">
                  {item.at ? (
                    <span className="dash-error-time" title={item.at}>
                      {new Date(item.at).toLocaleTimeString()}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="dash-error-copy-btn"
                    onClick={() => void copyErrorText(errorText, item.__key)}
                    title="复制错误详情"
                    aria-label="复制错误详情"
                  >
                    {isCopied ? <CheckOutlined className="dash-error-copy-ok" /> : <CopyOutlined />}
                  </button>
                </div>
              </div>

              {showPipeline ? (
                <div className="dash-error-pipeline">
                  {isCrossRoute ? (
                    <div className="dash-error-chain-step">
                      <span className="dash-chain-pill source">
                        {item.familyProvider ? <ProviderIcon provider={item.familyProvider as Provider} size={13} /> : null}
                        <span>{sourceProtocolLabel || item.familyProvider?.toUpperCase()}</span>
                      </span>
                      <ArrowRightOutlined className="dash-chain-arrow" />
                      <span className="dash-chain-pill target">
                        {provider ? <ProviderIcon provider={provider as Provider} size={13} /> : null}
                        <span>{targetProviderLabel}</span>
                      </span>
                    </div>
                  ) : (
                    <div className="dash-error-chain-step">
                      <span className="dash-chain-pill target">
                        {provider ? <ProviderIcon provider={provider as Provider} size={13} /> : null}
                        <span>{targetProviderLabel}</span>
                      </span>
                    </div>
                  )}

                  {isAlias && displayRequestedModel && displayEffectiveModel ? (
                    <div className="dash-error-alias-step">
                      <span className="dash-alias-pill req" title={`客户端请求模型: ${displayRequestedModel}`}>
                        {displayRequestedModel}
                      </span>
                      <SwapOutlined className="dash-chain-arrow" />
                      <span className="dash-alias-pill eff" title={`实际生效模型: ${displayEffectiveModel}`}>
                        {displayEffectiveModel}
                      </span>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="dash-error-chips">
                {item.model && !isAlias ? (
                  <Tag className="dash-error-tag dash-error-tag--model" title={`请求模型: ${item.model}`}>
                    {item.model}
                  </Tag>
                ) : null}

                {item.projectPath ? (
                  <Tooltip title={`项目路径: ${item.projectPath} (点击在会话中打开)`}>
                    <Tag
                      className="dash-error-tag dash-error-tag--project clickable"
                      icon={<FolderOutlined />}
                      onClick={() => onJumpToChat({ projectPath: item.projectPath })}
                    >
                      {projectBasename}
                    </Tag>
                  </Tooltip>
                ) : null}

                {item.sessionId ? (
                  <Tooltip title={`会话 ID: ${item.sessionId} (点击直达该会话)`}>
                    <Tag
                      className="dash-error-tag dash-error-tag--session clickable"
                      icon={<MessageOutlined />}
                      onClick={() => onJumpToChat({ projectPath: item.projectPath, sessionId: item.sessionId })}
                    >
                      {sessionShortId}
                    </Tag>
                  </Tooltip>
                ) : null}

                {item.route && item.route !== '/v1/chat/completions' ? (
                  <Tag className="dash-error-tag dash-error-tag--route" icon={<CompassOutlined />}>
                    {item.route}
                  </Tag>
                ) : null}
              </div>

              <div className="dash-error-msg">{errorText}</div>
            </article>
          );
        })}
      </div>
    </section>
  );
});

export default DashboardRecentErrors;
