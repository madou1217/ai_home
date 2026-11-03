import { Button, Form, Input, Select, Space, Switch, Tag } from 'antd';
import type { ActivityParamField, ActivityParamOption, ActivityProbeResult } from '@/types';

/**
 * schema 驱动的活动参数表单。
 *
 * 这里**不认识任何具体参数**：渲染哪种控件完全由 `field.type` 决定，候选值由服务端
 * 给（账号来自凭据库端口，类型来自描述符声明）。新增一个参数只需要改 provider
 * 描述符，这个组件与计划任务页面都不用动。
 */
export interface ActivityParamFieldsProps {
  fields: ActivityParamField[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  accountOptions?: ActivityParamOption[];
  probe?: ActivityProbeResult | null;
  probing?: boolean;
  onProbe?: () => void;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function kindHint(probe: ActivityProbeResult | null | undefined, kindId: string): string {
  const kind = (probe?.kinds || []).find((item) => item.id === kindId);
  if (!kind) return '';
  if (kind.claimable === false) return '当前不可领';
  const count = (probe?.plans || []).filter((plan) => plan.planKind === kindId).length;
  return count > 0 ? `${count} 个套餐可领` : '当前可领';
}

export function ActivityParamFields({
  fields,
  value,
  onChange,
  accountOptions = [],
  probe = null,
  probing = false,
  onProbe
}: ActivityParamFieldsProps) {
  if (fields.length === 0) return null;

  const setField = (key: string, next: unknown) => {
    const merged = { ...value };
    if (next === undefined || next === null || next === '' || (Array.isArray(next) && next.length === 0)) {
      delete merged[key];
    } else {
      merged[key] = next;
    }
    onChange(merged);
  };

  return (
    <>
      {fields.map((field) => {
        if (field.type === 'account-refs') {
          const placeholder = field.emptyMeans === 'all' ? '留空 = 全部账号' : '留空 = 不限';
          return (
            <Form.Item key={field.key} label={field.label}>
              <Select
                mode="multiple"
                allowClear
                showSearch
                optionFilterProp="label"
                placeholder={placeholder}
                value={readStringList(value[field.key])}
                onChange={(next) => setField(field.key, next)}
                options={accountOptions.map((option) => ({
                  value: option.value,
                  label: option.label,
                  title: option.description || option.label
                }))}
              />
              {field.description ? (
                <div className="scheduled-tasks-hint">{field.description}</div>
              ) : null}
            </Form.Item>
          );
        }

        if (field.type === 'enum') {
          const options = (field.options || []).map((option) => {
            const hint = kindHint(probe, option.value);
            return {
              value: option.value,
              label: hint ? `${option.label} · ${hint}` : option.label,
              title: option.description || option.label
            };
          });
          return (
            <Form.Item key={field.key} label={field.label}>
              <Space.Compact style={{ width: '100%' }}>
                <Select
                  allowClear
                  style={{ flex: 1 }}
                  placeholder={field.emptyMeans === 'any' ? '不限' : '请选择'}
                  value={typeof value[field.key] === 'string' ? (value[field.key] as string) : undefined}
                  onChange={(next) => setField(field.key, next)}
                  options={options}
                />
                {onProbe ? (
                  <Button loading={probing} onClick={onProbe}>探测</Button>
                ) : null}
              </Space.Compact>
              {field.description ? (
                <div className="scheduled-tasks-hint">{field.description}</div>
              ) : null}
              {probe?.kinds && probe.kinds.length > 0 ? (
                <div className="scheduled-tasks-hint">
                  {probe.kinds.map((kind) => (
                    <Tag key={kind.id} color={kind.claimable ? 'green' : 'default'}>
                      {kind.label}
                      {kind.claimable ? ' · 可领' : ' · 不可领'}
                    </Tag>
                  ))}
                </div>
              ) : null}
            </Form.Item>
          );
        }

        if (field.type === 'boolean') {
          return (
            <Form.Item key={field.key} label={field.label}>
              <Switch
                checked={value[field.key] === true}
                onChange={(checked) => setField(field.key, checked)}
              />
            </Form.Item>
          );
        }

        return (
          <Form.Item key={field.key} label={field.label}>
            <Input
              value={typeof value[field.key] === 'string' ? (value[field.key] as string) : ''}
              placeholder={field.description || ''}
              onChange={(event) => setField(field.key, event.target.value)}
            />
          </Form.Item>
        );
      })}
    </>
  );
}
