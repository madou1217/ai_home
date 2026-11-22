import { Button, Tag } from 'antd';
import type { EgressStrategyStatus } from '@/features/egress-upstream/types';

const STRATEGY_LAYER_LABELS: Record<string, string> = {
  application: '应用层',
  system: '系统层',
  network: '网络层'
};

const STRATEGY_STATUS_LABELS: Record<string, { label: string; color: 'success' | 'warning' | 'default' }> = {
  ready: { label: '可用', color: 'success' },
  degraded: { label: '待补齐', color: 'warning' },
  unavailable: { label: '当前不可用', color: 'default' }
};

export default function ProviderNetworkStrategies({
  strategies,
  canApply,
  onApply
}: {
  strategies: EgressStrategyStatus[];
  canApply: boolean;
  onApply: (strategy: EgressStrategyStatus) => void;
}) {
  return (
    <section className="pn-strategies" aria-label="出口策略">
      <div className="pn-layer-head">
        <strong>出口策略</strong>
        <span>服务端策略目录与当前可用性；新增策略只需加一条声明，页面会自动出现。</span>
      </div>
      <div className="pn-strategy-grid">
        {strategies.map((strategy) => {
          const status = STRATEGY_STATUS_LABELS[strategy.status] || STRATEGY_STATUS_LABELS.unavailable;
          return (
            <div className="pn-strategy" data-status={strategy.status} key={strategy.id}>
              <div className="pn-strategy-head">
                <strong>{strategy.label}</strong>
                <Tag bordered={false} color={status.color}>{status.label}</Tag>
              </div>
              <div className="pn-strategy-meta">
                <Tag bordered={false}>{STRATEGY_LAYER_LABELS[strategy.layer] || strategy.layer}</Tag>
                {strategy.requiresMihomo ? <Tag bordered={false}>mihomo</Tag> : null}
                {strategy.requiresSsh ? <Tag bordered={false}>SSH</Tag> : null}
                <span className="pn-muted">
                  {strategy.boundAccounts ? `${strategy.boundAccounts} 个账号使用` : '暂无账号使用'}
                </span>
              </div>
              <p>{strategy.description}</p>
              {strategy.reason ? <small>{strategy.reason}</small> : null}
              <Button
                size="small"
                type="link"
                className="pn-strategy-action"
                disabled={!canApply || strategy.status === 'unavailable'}
                onClick={() => onApply(strategy)}
              >
                应用到全部账号
              </Button>
            </div>
          );
        })}
        {!strategies.length ? <span className="pn-muted">策略目录暂不可用；出口弹窗会再次尝试读取服务端目录。</span> : null}
      </div>
    </section>
  );
}
