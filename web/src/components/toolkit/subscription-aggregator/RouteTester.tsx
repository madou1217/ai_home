import { useState } from 'react';
import { Descriptions, Input, Select, Space, Typography } from 'antd';
import type { FormInstance } from 'antd';
import Button from '@/components/ui/AppButton';
import { aggregatorErrorText, buildPolicyOptions, responseErrorCode } from './aggregator-presentation';
import { RULE_TYPE_LABELS, upsertCustomRule } from './rule-input';
import { describeTraceEnd, describeTraceGroups, describeTraceRule, traceRuleCandidates } from './route-trace-presentation';
import { subscriptionAggregatorAPI } from './subscription-aggregator-api';
import type { AggregatorCatalog, AggregatorProfileInput, AggregatorRouteTrace } from './types';
import styles from './SubscriptionAggregator.module.css';

const { Text } = Typography;

interface RouteTesterProps {
  form: FormInstance<AggregatorProfileInput>;
  catalog: Pick<AggregatorCatalog, 'presets' | 'groupTypes'>;
  /** 「为它添加规则」可选的策略（与自定义规则相同） */
  policyOptions: ReturnType<typeof buildPolicyOptions>;
}

/**
 * 规则测试：用编辑中（未保存）的配置判断一个网址 / 域名 / IP 命中哪条规则、走哪个组；
 * 结果不对时可以直接为它加一条自定义规则（排在内置规则之前），加完自动重测。
 */
export default function RouteTester({ form, catalog, policyOptions }: RouteTesterProps) {
  const [target, setTarget] = useState('');
  const [trace, setTrace] = useState<AggregatorRouteTrace | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [policy, setPolicy] = useState('proxy');

  const run = async (value: string) => {
    const text = value.trim();
    if (!text) return;
    setLoading(true);
    setError('');
    try {
      const next = await subscriptionAggregatorAPI.testRoute(form.getFieldsValue(true) as AggregatorProfileInput, text);
      setTrace(next);
      setCandidateIndex(traceRuleCandidates(next.target).defaultIndex);
    } catch (testError) {
      setTrace(null);
      setError(aggregatorErrorText(responseErrorCode(testError), '测试失败'));
    } finally {
      setLoading(false);
    }
  };

  const { candidates } = trace ? traceRuleCandidates(trace.target) : { candidates: [] };
  const addRule = () => {
    const rule = candidates[candidateIndex];
    if (!trace || !rule) return;
    const custom = (form.getFieldValue(['rules', 'custom']) as AggregatorProfileInput['rules']['custom'] | undefined) || [];
    form.setFieldValue(['rules', 'custom'], upsertCustomRule(custom, { ...rule, policy }));
    void run(trace.target.value);
  };

  return (
    <div className={styles.routeTester}>
      <Input.Search
        value={target}
        onChange={(event) => setTarget(event.target.value)}
        onSearch={(value) => void run(value)}
        enterButton="测试"
        loading={loading}
        allowClear
        placeholder="输入网址、域名或 IP，看它走哪条规则"
        aria-label="测试分流"
      />
      {error ? <Text type="danger">{error}</Text> : null}
      {trace ? (
        <>
          <Descriptions
            size="small"
            column={1}
            items={[
              { key: 'rule', label: '命中', children: describeTraceRule(trace.rule, catalog.presets) },
              ...(trace.groups.length
                ? [{ key: 'path', label: '经过', children: describeTraceGroups(trace.groups, catalog.groupTypes).join(' → ') }]
                : []),
              { key: 'end', label: '去向', children: describeTraceEnd(trace) }
            ]}
          />
          {trace.unavailable.length > 0 && (
            <Text type="warning">规则集 {trace.unavailable.join('、')} 下载失败，没有参与判断，结果可能不准。</Text>
          )}
          <Space size={8} wrap>
            <Text type="secondary">改成让</Text>
            <Select
              value={candidateIndex}
              onChange={setCandidateIndex}
              options={candidates.map((rule, index) => ({ value: index, label: `${rule.value}（${RULE_TYPE_LABELS[rule.type]}）` }))}
              popupMatchSelectWidth={false}
              aria-label="规则匹配范围"
            />
            <Text type="secondary">走</Text>
            <Select
              value={policy}
              onChange={setPolicy}
              options={policyOptions}
              showSearch
              optionFilterProp="label"
              popupMatchSelectWidth={false}
              aria-label="规则目标策略"
            />
            <Button onClick={addRule}>添加规则</Button>
          </Space>
        </>
      ) : null}
    </div>
  );
}
