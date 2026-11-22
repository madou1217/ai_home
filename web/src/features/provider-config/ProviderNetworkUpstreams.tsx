import { Tag, Tooltip } from 'antd';
import InlineNote from '@/components/ui/InlineNote';
import type { EgressUpstream } from '@/features/egress-upstream/types';
import { collectProviderRules } from './provider-network-model';

export default function ProviderNetworkUpstreams({
  upstreams,
  hasView
}: {
  upstreams: EgressUpstream[];
  hasView: boolean;
}) {
  return (
    <div className="pn-upstreams">
      {upstreams.map((upstream) => {
        const rules = collectProviderRules(upstream);
        return (
          <section className="pn-upstream" key={upstream.id} aria-label={`${upstream.host} 地区规则`}>
            <div className="pn-upstream-head">
              <strong>{upstream.host}</strong>
              <Tag bordered={false}>{upstream.official ? '官方' : '自定义'}</Tag>
              <span className="pn-muted">
                允许 {upstream.summary.allowed} · 拒绝 {upstream.summary.denied} · 待查 {upstream.summary.pending}
              </span>
            </div>
            <div className="pn-rules">
              {rules.length ? rules.slice(0, 8).map((rule) => (
                <Tooltip
                  key={rule.id}
                  title={[rule.note, rule.source === 'hint' ? '预置提示' : '用户规则'].filter(Boolean).join(' · ')}
                >
                  <Tag bordered={false} color={rule.effect === 'deny' ? 'error' : 'success'}>
                    {rule.text}
                  </Tag>
                </Tooltip>
              )) : (
                <span className="pn-muted">没有地区限制规则（按出口位置默认放行）</span>
              )}
              {rules.length > 8 ? <span className="pn-muted">还有 {rules.length - 8} 条</span> : null}
            </div>
          </section>
        );
      })}
      {!upstreams.length && hasView ? (
        <InlineNote tone="info">
          没有发现该 Provider 的上游主机：账号还没有可识别的官方端点，设置出口前先确认账号配置。
        </InlineNote>
      ) : null}
    </div>
  );
}
