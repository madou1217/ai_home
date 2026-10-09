import { useEffect, useMemo, useState } from 'react';
import {
  Checkbox,
  Drawer,
  Form,
  Input,
  InputNumber,
  Radio,
  Select,
  Space,
  Switch,
  Tabs,
  Typography
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { buildPolicyOptions, PROTOCOL_OPTIONS } from './aggregator-presentation';
import type { AggregatorCatalog, AggregatorProfileInput, AggregatorSource } from './types';
import styles from './SubscriptionAggregator.module.css';

const { Text } = Typography;

interface ProfileEditorDrawerProps {
  open: boolean;
  /** 编辑对象：已有聚合（带 id）或服务端给的新建模板 */
  profile: AggregatorProfileInput | null;
  catalog: AggregatorCatalog;
  sources: AggregatorSource[];
  manualNodeCount: number;
  width?: number | string;
  onClose: () => void;
  onSave: (profile: AggregatorProfileInput) => Promise<boolean>;
}

/** 聚合订阅编辑器：订阅源范围 → 节点处理 → 策略组 → 分流规则，四个分页共用一个表单。 */
export default function ProfileEditorDrawer({
  open,
  profile,
  catalog,
  sources,
  manualNodeCount,
  width = 760,
  onClose,
  onSave
}: ProfileEditorDrawerProps) {
  const [form] = Form.useForm<AggregatorProfileInput>();
  const [saving, setSaving] = useState(false);
  const allSources = Form.useWatch(['sources', 'all'], form);
  const perSource = Form.useWatch(['groups', 'perSource'], form);
  const presetById = useMemo(() => new Map(catalog.presets.map((preset) => [preset.id, preset])), [catalog.presets]);
  const policyContext = { catalog, sources };
  const groupPolicyOptions = buildPolicyOptions({ ...policyContext, includeSources: Boolean(perSource) });
  const rulePolicyOptions = buildPolicyOptions({ ...policyContext, includeSources: Boolean(perSource), includePresets: true });

  useEffect(() => {
    if (open && profile) {
      form.resetFields();
      form.setFieldsValue(profile);
    }
  }, [form, open, profile]);

  const submit = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      if (await onSave({ ...profile, ...values, id: profile?.id })) onClose();
    } catch (_validationError) {
      // 校验错误就地显示在对应字段。
    } finally {
      setSaving(false);
    }
  };

  const sourcesTab = (
    <>
      <Form.Item label="名称" name="name" rules={[{ required: true, whitespace: true, message: '请输入名称' }]}>
        <Input maxLength={64} placeholder="我的聚合订阅" />
      </Form.Item>
      <Form.Item label="订阅源" name={['sources', 'all']}>
        <Radio.Group>
          <Radio value>全部订阅源（以后新增的自动加入）</Radio>
          <Radio value={false}>只用指定的订阅源</Radio>
        </Radio.Group>
      </Form.Item>
      {allSources === false && (
        <Form.Item
          name={['sources', 'subscriptionIds']}
          rules={[{ type: 'array', min: 1, message: '至少选择一个订阅源' }]}
        >
          <Checkbox.Group
            className={styles.checkGrid}
            options={sources.map((source) => ({ label: `${source.name}（${source.nodeCount}）`, value: source.id }))}
          />
        </Form.Item>
      )}
      <Form.Item
        label={`包含手动导入的节点（${manualNodeCount} 个）`}
        name={['sources', 'includeManualNodes']}
        valuePropName="checked"
      >
        <Switch />
      </Form.Item>
      <Form.Item
        label="客户端拉取时自动刷新"
        name="refreshHours"
        extra="客户端更新订阅时，超过这个时长没同步过的订阅源会先重新拉取；0 表示只用手动同步的结果。"
      >
        <InputNumber min={0} max={720} addonAfter="小时" />
      </Form.Item>
    </>
  );

  const nodesTab = (
    <>
      <Form.Item label="只保留名称匹配" name={['filter', 'include']} extra="正则，不区分大小写；留空表示不过滤。">
        <Input placeholder="例如：港|日|新|美" allowClear />
      </Form.Item>
      <Form.Item label="排除名称匹配" name={['filter', 'exclude']} extra="默认排除机场写在节点名里的流量、到期等提示。">
        <Input allowClear />
      </Form.Item>
      <Form.Item label="协议" name={['filter', 'protocols']}>
        <Select mode="multiple" allowClear placeholder="全部协议" options={PROTOCOL_OPTIONS} />
      </Form.Item>
      <Space size={32} wrap>
        <Form.Item label="去除重复节点" name="dedupe" valuePropName="checked" tooltip="服务器、端口与凭据都相同的节点只保留第一个">
          <Switch />
        </Form.Item>
        <Form.Item label="节点名加订阅名前缀" name={['naming', 'sourcePrefix']} valuePropName="checked">
          <Switch />
        </Form.Item>
      </Space>
      <Form.Item label="改名规则" extra="按顺序对节点名做正则替换，例如把「Hong Kong」换成「香港」。重名时自动追加订阅名或序号。">
        <Form.List name={['naming', 'renames']}>
          {(fields, { add, remove }) => (
            <div className={styles.rowList}>
              {fields.map((field) => (
                <div key={field.key} className={styles.renameRow}>
                  <Form.Item name={[field.name, 'pattern']} rules={[{ required: true, message: '填写匹配' }]} noStyle>
                    <Input placeholder="匹配（正则）" aria-label="改名匹配" />
                  </Form.Item>
                  <Form.Item name={[field.name, 'replace']} noStyle>
                    <Input placeholder="替换为" aria-label="改名替换" />
                  </Form.Item>
                  <Button type="text" icon={<DeleteOutlined />} aria-label="删除改名规则" onClick={() => remove(field.name)} />
                </div>
              ))}
              <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ pattern: '', replace: '' })}>添加改名规则</Button>
            </div>
          )}
        </Form.List>
      </Form.Item>
    </>
  );

  const groupsTab = (
    <>
      <Form.Item label="地区分组" name={['groups', 'regions']} extra="按国旗或名称关键字归类，组内自动测速选最快；没有节点的地区不生成。">
        <Checkbox.Group
          className={styles.checkGrid}
          options={catalog.regions.map((region) => ({ label: `${region.flag} ${region.name}`, value: region.id }))}
        />
      </Form.Item>
      <Form.Item label="每个订阅源单独成组" name={['groups', 'perSource']} valuePropName="checked">
        <Switch />
      </Form.Item>
      <Space size={16} wrap align="start">
        <Form.Item label="测速地址" name={['groups', 'testUrl']} rules={[{ type: 'url', message: '请输入 http(s) 地址' }]}>
          <Input style={{ width: 320 }} />
        </Form.Item>
        <Form.Item label="测速间隔" name={['groups', 'testIntervalSec']}>
          <InputNumber min={30} max={86400} addonAfter="秒" />
        </Form.Item>
      </Space>
    </>
  );

  const rulesTab = (
    <>
      <Text type="secondary" className={styles.sectionHint}>
        规则组在客户端里是可切换的策略组，这里设的是默认选项。规则集来自 MetaCubeX/meta-rules-dat，由客户端自行下载更新。
      </Text>
      <Form.List name={['rules', 'presets']}>
        {(fields) => (
          <div className={styles.presetList}>
            {fields.map((field) => {
              const presetId = form.getFieldValue(['rules', 'presets', field.name, 'id']);
              const info = presetById.get(presetId);
              return (
                <div key={field.key} className={styles.presetRow}>
                  <Form.Item name={[field.name, 'id']} hidden><Input /></Form.Item>
                  <Form.Item name={[field.name, 'enabled']} valuePropName="checked" noStyle>
                    <Switch size="small" aria-label={`启用 ${info?.name || presetId}`} />
                  </Form.Item>
                  <span className={styles.presetText}>
                    <strong>{info?.name || presetId}</strong>
                    <small>{info?.description}</small>
                  </span>
                  <Form.Item name={[field.name, 'policy']} noStyle>
                    <Select className={styles.policySelect} options={groupPolicyOptions} aria-label={`${info?.name || presetId} 默认策略`} />
                  </Form.Item>
                </div>
              );
            })}
          </div>
        )}
      </Form.List>

      <Form.Item label="自定义规则" extra="排在内置规则之前，先匹配先生效。GEOSITE / GEOIP 填规则集名，例如 bilibili、cn。">
        <Form.List name={['rules', 'custom']}>
          {(fields, { add, remove }) => (
            <div className={styles.rowList}>
              {fields.map((field) => (
                <div key={field.key} className={styles.ruleRow}>
                  <Form.Item name={[field.name, 'type']} noStyle>
                    <Select options={catalog.ruleTypes.map((type) => ({ label: type, value: type }))} aria-label="规则类型" />
                  </Form.Item>
                  <Form.Item name={[field.name, 'value']} rules={[{ required: true, whitespace: true, message: '填写匹配值' }]} noStyle>
                    <Input placeholder="google.com / 1.1.1.0/24 / openai" aria-label="匹配值" />
                  </Form.Item>
                  <Form.Item name={[field.name, 'policy']} noStyle>
                    <Select options={rulePolicyOptions} aria-label="目标策略" />
                  </Form.Item>
                  <Button type="text" icon={<DeleteOutlined />} aria-label="删除规则" onClick={() => remove(field.name)} />
                </div>
              ))}
              <Button
                type="dashed"
                icon={<PlusOutlined />}
                onClick={() => add({ type: 'DOMAIN-SUFFIX', value: '', policy: 'proxy' })}
              >
                添加规则
              </Button>
            </div>
          )}
        </Form.List>
      </Form.Item>

      <Form.Item label="其余流量（漏网之鱼）默认走" name={['rules', 'finalPolicy']}>
        <Select options={groupPolicyOptions} style={{ maxWidth: 320 }} />
      </Form.Item>
    </>
  );

  return (
    <Drawer
      title={profile?.id ? `编辑聚合订阅 · ${profile.name}` : '新建聚合订阅'}
      open={open}
      onClose={onClose}
      width={width}
      destroyOnHidden
      extra={(
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={() => void submit()}>保存</Button>
        </Space>
      )}
    >
      <Form form={form} layout="vertical" requiredMark={false} scrollToFirstError>
        <Tabs
          items={[
            { key: 'sources', label: '订阅源', forceRender: true, children: sourcesTab },
            { key: 'nodes', label: '节点处理', forceRender: true, children: nodesTab },
            { key: 'groups', label: '策略组', forceRender: true, children: groupsTab },
            { key: 'rules', label: '分流规则', forceRender: true, children: rulesTab }
          ]}
        />
      </Form>
    </Drawer>
  );
}
