import { memo } from 'react';
import { PlusOutlined, ReloadOutlined, TeamOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import SettingStatusTag from '@/components/ui/SettingStatusTag';

export interface ModelsEmptyStateProps {
  accountScoped: boolean;
  hasCatalogModels: boolean;
  hasAccounts: boolean;
  hasActiveFilters: boolean;
  refreshing: boolean;
  refreshError: string;
  canCreateManualModel: boolean;
  onRefresh: () => void;
  onResetFilters: () => void;
  onAddManualModel: () => void;
  onGoAccounts: () => void;
}

/**
 * 零模型空状态：区分「筛选后为空」「尚未添加账号」「尚未刷新目录」「刷新失败」，
 * 说明原因并给出明确下一步动作。
 */
export const ModelsEmptyState = memo(function ModelsEmptyState({
  accountScoped,
  hasCatalogModels,
  hasAccounts,
  hasActiveFilters,
  refreshing,
  refreshError,
  canCreateManualModel,
  onRefresh,
  onResetFilters,
  onAddManualModel,
  onGoAccounts
}: ModelsEmptyStateProps) {
  if (hasCatalogModels && hasActiveFilters) {
    return (
      <div className="models-empty-state" role="status">
        <SettingStatusTag status="unset" label="筛选无结果" compact live="off" />
        <div className="models-empty-state-copy">
          <strong>当前筛选条件下没有匹配的模型</strong>
          <p>请清空搜索关键词，或将 Provider、账号、状态切换回「全部」。</p>
        </div>
        <div className="models-empty-state-actions">
          <Button type="primary" onClick={onResetFilters}>
            重置筛选
          </Button>
        </div>
      </div>
    );
  }

  if (refreshError) {
    return (
      <div className="models-empty-state" role="alert">
        <SettingStatusTag status="error" label="刷新失败" compact live="off" />
        <div className="models-empty-state-copy">
          <strong>未能获取到可用模型</strong>
          <p>上游探测没有返回可用模型；请检查账号授权或网络后重试，也可以手动补充模型。</p>
          {refreshError ? (
            <details className="models-refresh-error">
              <summary>查看探测错误</summary>
              <p>{refreshError}</p>
            </details>
          ) : null}
        </div>
        <div className="models-empty-state-actions">
          <Button type="primary" icon={<ReloadOutlined />} loading={refreshing} onClick={onRefresh}>
            重新刷新
          </Button>
          {canCreateManualModel ? (
            <Button icon={<PlusOutlined />} onClick={onAddManualModel}>
              手动添加模型
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (!accountScoped && !hasAccounts) {
    return (
      <div className="models-empty-state" role="status">
        <SettingStatusTag status="unset" label="未接入账号" compact live="off" />
        <div className="models-empty-state-copy">
          <strong>还没有可用于探测模型的账号</strong>
          <p>模型目录来自已接入账号的上游探测结果。请先在账号页添加并启用至少一个账号。</p>
        </div>
        <div className="models-empty-state-actions">
          <Button type="primary" icon={<TeamOutlined />} onClick={onGoAccounts}>
            前往账号管理
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="models-empty-state" role="status">
      <SettingStatusTag
        status={refreshing ? 'saving' : 'unset'}
        label={refreshing ? '刷新中' : '未发现模型'}
        compact
        live="off"
      />
      <div className="models-empty-state-copy">
        <strong>{accountScoped ? '当前账号暂无可用模型' : '模型目录尚未加载出模型'}</strong>
        <p>
          {accountScoped
            ? '点击「刷新模型」从上游探测该账号支持的模型列表，或手动补充模型 ID。'
            : '点击「刷新模型」读取最新模型缓存，或前往具体账号执行上游探测与手动补充。'}
        </p>
      </div>
      <div className="models-empty-state-actions">
        <Button type="primary" icon={<ReloadOutlined />} loading={refreshing} onClick={onRefresh}>
          刷新模型
        </Button>
        {canCreateManualModel ? (
          <Button icon={<PlusOutlined />} onClick={onAddManualModel}>
            手动添加模型
          </Button>
        ) : null}
        {!accountScoped ? (
          <Button icon={<TeamOutlined />} onClick={onGoAccounts}>
            查看账号
          </Button>
        ) : null}
      </div>
    </div>
  );
});

export default ModelsEmptyState;
