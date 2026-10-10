import { Button, Card, Checkbox, Form, Input, Select, Space, Switch, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { UpstreamErrorKind, UpstreamErrorRule } from '@/types';
import { useEffect, useState } from 'react';
import { upstreamErrorMappingsAPI } from '@/services/api';
import { createNewApiBalanceRule } from './upstream-error-mapping-presets';
import './upstream-error-rules-editor.css';

const kinds: { value: UpstreamErrorKind; label: string }[] = [
  { value: 'billing_blocked', label: '余额不足 / 账单受限（整账号）' },
  { value: 'quota_exhausted', label: '额度耗尽（整账号）' },
  { value: 'auth_invalid', label: '凭据失效（整账号）' },
  { value: 'permission_denied', label: '权限受限（整账号）' },
  { value: 'rate_limited', label: '临时限流（当前模型）' },
  { value: 'service_unavailable', label: '服务不可用（当前模型）' }
];
function defaultMatcher() {
  return { source: 'json', path: 'error.code', operator: 'equals', value: '' };
}

export function UpstreamErrorRulesEditor({
  listName = 'upstreamErrorRules',
  includeGroups = true,
  provider
}: { listName?: string; includeGroups?: boolean; provider?: string }) {
  const form = Form.useFormInstance();
  const [groups, setGroups] = useState<{ id: string; name: string; provider: string; enabled: boolean }[]>([]);
  const rulesValue = Form.useWatch(listName, form);
  const selectedGroupIds = Form.useWatch('upstreamErrorGroupIds', form);
  useEffect(() => {
    if (!includeGroups) return;
    void upstreamErrorMappingsAPI.getAll().then(setGroups).catch(() => setGroups([]));
  }, [includeGroups]);
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const selectedIds = Array.isArray(selectedGroupIds)
    ? selectedGroupIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const visibleGroups = groups.filter((group) => !normalizedProvider || group.provider === 'all' || group.provider === normalizedProvider);
  const visibleIds = new Set(visibleGroups.map((group) => group.id));
  const detachedOptions = selectedIds
    .filter((id) => !visibleIds.has(id))
    .map((id) => ({
      label: `已挂载映射组 ${id}（当前不可用，取消挂载）`,
      value: id,
      disabled: false
    }));
  const groupOptions = [
    ...visibleGroups.map((group) => ({
      label: `${group.name}${group.provider && group.provider !== 'all' ? `（${group.provider}）` : ''}${group.enabled === false ? '（已停用）' : ''}`,
      value: group.id,
      // A disabled group may already be selected. Keep it interactive so the
      // account can remove a stale attachment without editing raw JSON.
      disabled: group.enabled === false && !selectedIds.includes(group.id)
    })),
    ...detachedOptions
  ];
  return (
    <>
    {includeGroups ? (
      <Form.Item name="upstreamErrorGroupIds" label="异常映射组" extra="映射组在设置页统一维护，可挂到多个账号；账号专属规则仍可继续使用。">
        <Checkbox.Group options={groupOptions} />
      </Form.Item>
    ) : null}
    <Form.List name={listName}>
      {(rules, { add, remove, move }) => (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <Typography.Text strong>异常识别规则组</Typography.Text>
            <div><Typography.Text type="secondary">
              按顺序取首条命中规则；状态码和所有匹配条件须同时满足。仅检查上游错误响应。
            </Typography.Text></div>
            <div><Typography.Text type="secondary">
              余额、额度和权限阻塞不会被模型列表探测解除；额度可由新用量快照恢复，余额和权限恢复后需手动恢复调度。
            </Typography.Text></div>
          </div>
          {rules.map((rule, index) => (
            <Card key={rule.key} size="small" title={`规则 ${index + 1}`} extra={(
              <Space size={0}>
                <Button aria-label="上移规则" type="text" disabled={index === 0} icon={<ArrowUpOutlined />} onClick={() => move(index, index - 1)} />
                <Button aria-label="下移规则" type="text" disabled={index === rules.length - 1} icon={<ArrowDownOutlined />} onClick={() => move(index, index + 1)} />
                <Button aria-label="删除规则" type="text" danger icon={<DeleteOutlined />} onClick={() => remove(rule.name)} />
              </Space>
            )}>
              <Space align="start" wrap>
                <Form.Item name={[rule.name, 'enabled']} valuePropName="checked" label="启用"><Switch /></Form.Item>
                <Form.Item name={[rule.name, 'name']} label="名称" rules={[{ max: 80 }]}><Input placeholder="例如：余额不足" /></Form.Item>
              </Space>
              <Form.Item name={[rule.name, 'statuses']} label="HTTP 状态码" extra="留空表示任意错误状态；同码可用错误字段进一步区分。"
                getValueProps={(values: (string | number)[] | undefined) => ({ value: values?.map(String) })}
                normalize={(values: (string | number)[]) => values.map(Number)}
                rules={[{ validator: async (_, values: number[]) => {
                  if (values?.some(value => !Number.isInteger(value) || value < 400 || value > 599)) throw new Error('请输入 400–599 的状态码');
                } }]}
              ><Select mode="tags" tokenSeparators={[',', ' ']} options={['403', '429', '500', '503'].map(value => ({ value, label: value }))} /></Form.Item>
              <Form.List name={[rule.name, 'matchers']}>
                {(matchers, matcherActions) => (
                  <>
                    {matchers.map(matcher => {
                      const value: UpstreamErrorRule['matchers'][number] | undefined = rulesValue?.[rule.name]?.matchers?.[matcher.name]
                        || form.getFieldValue([listName, rule.name, 'matchers', matcher.name]);
                      const legacy = value && 'field' in value;
                      return (
                        <div key={matcher.key} className="upstream-error-matcher">
                          {legacy ? (
                            <>
                              <Form.Item name={[matcher.name, 'field']} className="upstream-error-matcher__source">
                                <Select aria-label="错误字段（兼容）" options={['code', 'type', 'message', 'body'].map(field => ({ value: field, label: field }))} />
                              </Form.Item>
                              <Form.Item name={[matcher.name, 'pattern']} rules={[{ required: true, message: '请输入正则' }, { max: 256 }]} className="upstream-error-matcher__value">
                                <Input aria-label="匹配正则" placeholder="^insufficient_user_quota$" />
                              </Form.Item>
                            </>
                          ) : (
                            <>
                              <Form.Item name={[matcher.name, 'source']} rules={[{ required: true, message: '请选择来源' }]} className="upstream-error-matcher__source">
                                <Select aria-label="匹配来源" options={[{ value: 'http_code', label: 'HTTP 状态' }, { value: 'body', label: '正文文本' }, { value: 'json', label: 'JSON 路径' }]} />
                              </Form.Item>
                              <Form.Item name={[matcher.name, 'operator']} rules={[{ required: true, message: '请选择匹配方式' }]} className="upstream-error-matcher__operator">
                                <Select aria-label="匹配方式" options={[{ value: 'equals', label: '等于' }, { value: 'contains', label: '包含' }, { value: 'regex', label: '正则' }]} />
                              </Form.Item>
                              {value && 'source' in value && value.source === 'json' ? (
                                <Form.Item name={[matcher.name, 'path']} rules={[{ required: true, message: '请输入 JSON 路径' }, { max: 256 }]} className="upstream-error-matcher__path">
                                  <Input aria-label="JSON 路径" placeholder="error.code" />
                                </Form.Item>
                              ) : null}
                              <Form.Item name={[matcher.name, 'value']} rules={[{ required: true, message: '请输入匹配值' }, { validator: async (_, value) => {
                                if (String(value ?? '').length > 4096) throw new Error('匹配值不能超过 4096 字符');
                              } }]} className="upstream-error-matcher__value">
                                <Input aria-label="匹配值" placeholder="insufficient_user_quota" />
                              </Form.Item>
                            </>
                          )}
                          <Button aria-label="删除匹配条件" type="text" disabled={matchers.length <= 1} icon={<DeleteOutlined />} onClick={() => matcherActions.remove(matcher.name)} />
                        </div>
                      );
                    })}
                    <Button type="link" size="small" disabled={matchers.length >= 8} onClick={() => matcherActions.add(defaultMatcher())}>添加匹配条件（且）</Button>
                  </>
                )}
              </Form.List>
              <Form.Item name={[rule.name, 'kind']} label="转换为" rules={[{ required: true, message: '请选择标准状态' }]} style={{ marginTop: 12, marginBottom: 0 }}>
                <Select options={kinds} />
              </Form.Item>
            </Card>
          ))}
          <Typography.Text type="secondary">来源与所有条件同时满足；JSON 路径支持 error.code、data.items[0].code 这类点路径。正则忽略大小写。</Typography.Text>
          <Space wrap>
            <Button icon={<PlusOutlined />} disabled={rules.length >= 20} onClick={() => add({ name: '', enabled: true, statuses: [], kind: 'billing_blocked', matchers: [defaultMatcher()] })}>添加异常规则</Button>
            <Button disabled={rules.length >= 20} onClick={() => add(createNewApiBalanceRule())}>添加余额不足示例</Button>
          </Space>
        </Space>
      )}
    </Form.List>
    </>
  );
}
