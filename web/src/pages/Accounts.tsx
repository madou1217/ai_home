import React, { useState, useEffect, useMemo } from 'react';
import {
  Table,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  Radio,
  Segmented,
  Alert,
  message,
  Card,
  Tabs,
  Statistic,
  Row,
  Col,
  Dropdown,
  Typography,
  Grid,
  List,
  Empty
} from 'antd';
import type { MenuProps } from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ReloadOutlined,
  FilterOutlined,
  MoreOutlined,
  SyncOutlined,
  ExportOutlined,
  ImportOutlined
} from '@ant-design/icons';
import { accountsAPI, managementAPI } from '@/services/api';
import type {
  Account,
  AccountAddJob,
  AccountAuthMode,
  Provider
} from '@/types';
import ProviderIcon from '@/components/chat/ProviderIcon';
import RuntimeStatusTag from '@/components/runtime/RuntimeStatusTag';
import UsageSnapshotCell from '@/components/account/UsageSnapshotCell';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const PROVIDER_AUTH_OPTIONS: Record<Provider, Array<{
  value: AccountAuthMode;
  label: string;
  description: string;
}>> = {
  codex: [
    {
      value: 'oauth-browser',
      label: 'ChatGPT / OpenAI 登录',
      description: '使用 Codex 原生浏览器登录流程，适合本机交互授权。'
    },
    {
      value: 'oauth-device',
      label: '设备码登录',
      description: '适合远程环境，通过 device auth 完成 Codex 登录。'
    },
    {
      value: 'api-key',
      label: 'OpenAI API Key',
      description: '绑定 OPENAI_API_KEY / OPENAI_BASE_URL。'
    }
  ],
  claude: [
    {
      value: 'oauth-browser',
      label: 'Claude 登录',
      description: '使用 Claude Code 原生 login 流程（Claude.ai 凭据）。'
    },
    {
      value: 'api-key',
      label: 'Anthropic API Key',
      description: '绑定 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL。'
    }
  ],
  gemini: [
    {
      value: 'oauth-browser',
      label: 'Google 登录',
      description: '使用 Gemini CLI 原生 Google 登录流程。'
    },
    {
      value: 'api-key',
      label: 'Gemini API Key',
      description: '绑定 GEMINI_API_KEY 或 GOOGLE_API_KEY。'
    }
  ]
};

const PROVIDER_UNAVAILABLE_AUTH_OPTIONS: Partial<Record<Provider, Array<{
  label: string;
  description: string;
}>>> = {
  claude: [
    {
      label: 'Claude Bedrock',
      description: '官方生态里存在该接入方向，但本项目当前还未完成账号导入、运行时读取和服务路由闭环。'
    },
    {
      label: 'Claude Vertex',
      description: '官方生态里存在该接入方向，但本项目当前还未完成账号导入、运行时读取和服务路由闭环。'
    },
    {
      label: 'Claude Foundry',
      description: '官方生态里存在该接入方向，但本项目当前还未完成账号导入、运行时读取和服务路由闭环。'
    }
  ],
  gemini: [
    {
      label: 'Gemini Vertex AI',
      description: '官方生态里存在该接入方向，但本项目当前还未完成账号导入、运行时读取和服务路由闭环。'
    }
  ]
};

const PROVIDER_CAPABILITY_HINTS: Record<Provider, string> = {
  codex: 'Codex 当前已接通浏览器登录、设备码登录和 API Key。',
  claude: 'Claude 当前已接通 Claude 登录与 Anthropic API Key。Bedrock / Vertex / Foundry 需要单独补齐后端接入链路。',
  gemini: 'Gemini 当前已接通 Google 登录与 Gemini API Key。Vertex AI 需要单独补齐后端接入链路。'
};

function getAccountPrimaryLabel(record: Pick<Account, 'email' | 'displayName' | 'provider' | 'accountId'>) {
  return record.email || record.displayName || `${record.provider}-${record.accountId}`;
}

function getAccountMetaLabel(record: Pick<Account, 'apiKeyMode' | 'planType'>) {
  return `${record.apiKeyMode ? 'API Key' : 'OAuth'} · ${record.planType || 'free'}`;
}

function getAccountKey(record: Pick<Account, 'provider' | 'accountId'>) {
  return `${record.provider}-${record.accountId}`;
}

function mergeAccountRecord(current: Account, incoming: Account): Account {
  const fallbackDisplayName = `${incoming.provider}-${incoming.accountId}`;
  const merged: Account = {
    ...current,
    ...incoming
  };

  if (!merged.configured || merged.apiKeyMode) {
    return merged;
  }

  if (!incoming.email && current.email) {
    merged.email = current.email;
  }
  if (!incoming.usageSnapshot && current.usageSnapshot) {
    merged.usageSnapshot = current.usageSnapshot;
  }
  if ((incoming.remainingPct == null) && current.remainingPct != null) {
    merged.remainingPct = current.remainingPct;
  }
  if (
    (!incoming.planType || incoming.planType === 'oauth' || incoming.planType === 'pending')
    && current.planType
    && current.planType !== 'oauth'
    && current.planType !== 'pending'
  ) {
    merged.planType = current.planType;
  }
  if ((!incoming.displayName || incoming.displayName === fallbackDisplayName) && current.displayName) {
    merged.displayName = current.displayName;
  }
  if (incoming.runtimeStatus == null && current.runtimeStatus != null) {
    merged.runtimeStatus = current.runtimeStatus;
  }
  if (incoming.runtimeUntil == null && current.runtimeUntil != null) {
    merged.runtimeUntil = current.runtimeUntil;
  }
  if (incoming.runtimeReason == null && current.runtimeReason != null) {
    merged.runtimeReason = current.runtimeReason;
  }

  return merged;
}

const Accounts = () => {
  const { Paragraph, Text } = Typography;
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [hydratingDetails, setHydratingDetails] = useState(false);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [addJobId, setAddJobId] = useState<string | null>(null);
  const [addJob, setAddJob] = useState<AccountAddJob | null>(null);
  const [authProgressVisible, setAuthProgressVisible] = useState(false);
  const [form] = Form.useForm();
  const [activeProvider, setActiveProvider] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [importModalVisible, setImportModalVisible] = useState(false);
  const [importMode, setImportMode] = useState<'file' | 'path' | 'text'>('file');
  const [importPath, setImportPath] = useState('');
  const [importText, setImportText] = useState('');
  const importInputRef = React.useRef<HTMLInputElement>(null);
  const successAutoCloseTimerRef = React.useRef<number | null>(null);
  const selectedProvider = Form.useWatch('provider', form) as Provider | undefined;
  const selectedAuthMode = (Form.useWatch('authMode', form) as AccountAuthMode | undefined) || 'oauth-browser';
  const providerAuthOptions = selectedProvider ? PROVIDER_AUTH_OPTIONS[selectedProvider] : [];
  const unavailableAuthOptions = selectedProvider ? (PROVIDER_UNAVAILABLE_AUTH_OPTIONS[selectedProvider] || []) : [];
  const providerCapabilityHint = selectedProvider ? PROVIDER_CAPABILITY_HINTS[selectedProvider] : '';

  const mergeAccounts = React.useCallback((current: Account[], incoming: Account[]) => {
    const currentMap = new Map<string, Account>(
      current.map((account) => [getAccountKey(account), account])
    );
    const nextMap = new Map<string, Account>();
    incoming.forEach((account) => {
      const key = getAccountKey(account);
      const previous = currentMap.get(key);
      nextMap.set(key, previous ? mergeAccountRecord(previous, account) : account);
    });
    return Array.from(nextMap.values());
  }, []);

  const mergeSingleAccount = React.useCallback((current: Account[], incoming: Account) => {
    const next = current.slice();
    const key = getAccountKey(incoming);
    const index = next.findIndex((account) => getAccountKey(account) === key);
    if (index >= 0) {
      next[index] = mergeAccountRecord(next[index], incoming);
      return next;
    }
    next.push(incoming);
    return next;
  }, []);

  const closeAuthProgressPanel = React.useCallback(() => {
    if (successAutoCloseTimerRef.current !== null) {
      window.clearTimeout(successAutoCloseTimerRef.current);
      successAutoCloseTimerRef.current = null;
    }
    setAddJobId(null);
    setAddJob(null);
    setAuthProgressVisible(false);
  }, []);

  const handleExport = async () => {
    try {
      await accountsAPI.export();
      message.success('导出成功');
    } catch { message.error('导出失败'); }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const result = await accountsAPI.import({ content: text });
      message.success(`导入成功，共 ${result.imported} 个账号`);
      loadAccounts();
    } catch { message.error('导入失败，请检查文件格式'); }
    e.target.value = '';
  };

  const handleImportSubmit = async () => {
    try {
      const payload = importMode === 'path'
        ? { mode: 'path', path: importPath.trim() }
        : { content: importText };
      const result = await accountsAPI.import(payload);
      message.success(`导入成功，共 ${result.imported || 0} 个账号`);
      setImportModalVisible(false);
      setImportPath('');
      setImportText('');
      loadAccounts();
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '导入失败');
    }
  };

  const loadAccounts = React.useCallback(async () => {
    if (hasLoadedOnce) setRefreshing(true);
    else setLoading(true);
    try {
      const payload = await accountsAPI.list();
      setAccounts((current) => mergeAccounts(current, payload.accounts));
      setHydratingDetails(payload.hydrating);
      setHasLoadedOnce(true);
    } catch (_error) {
      message.error('加载账号失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [hasLoadedOnce, mergeAccounts]);

  useEffect(() => {
    loadAccounts();
    const interval = setInterval(loadAccounts, 30000);
    return () => clearInterval(interval);
  }, [loadAccounts]);

  useEffect(() => {
    const watcher = accountsAPI.watch({
      onSnapshot: ({ accounts: snapshotAccounts, hydrating }) => {
        setAccounts((current) => mergeAccounts(current, snapshotAccounts));
        setHydratingDetails(Boolean(hydrating));
        setHasLoadedOnce(true);
        setLoading(false);
      },
      onAccount: (account) => {
        setAccounts((current) => mergeSingleAccount(current, account));
      },
      onHydrated: () => {
        setHydratingDetails(false);
      },
      onError: () => {
        setHydratingDetails(false);
      }
    });
    return () => {
      watcher.close();
    };
  }, [mergeAccounts, mergeSingleAccount]);

  useEffect(() => {
    return () => {
      if (successAutoCloseTimerRef.current !== null) {
        window.clearTimeout(successAutoCloseTimerRef.current);
        successAutoCloseTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!addJobId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const job = await accountsAPI.getAddJob(addJobId);
        if (cancelled) return;
        setAddJob(job);
        if (job.status === 'succeeded') {
          loadAccounts();
          setAddJobId(null);
          message.success(`OAuth 账号 ${job.provider}-${job.accountId} 添加成功`);
          if (successAutoCloseTimerRef.current !== null) {
            window.clearTimeout(successAutoCloseTimerRef.current);
          }
          successAutoCloseTimerRef.current = window.setTimeout(() => {
            closeAuthProgressPanel();
          }, 800);
        } else if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'expired') {
          setAddJobId(null);
        }
      } catch (_error) {
        if (!cancelled) {
          setAddJobId(null);
        }
      }
    };

    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [addJobId, closeAuthProgressPanel]);

  useEffect(() => {
    if (!selectedProvider) return;
    const allowedModes = PROVIDER_AUTH_OPTIONS[selectedProvider].map((item) => item.value);
    if (!allowedModes.includes(selectedAuthMode)) {
      form.setFieldValue('authMode', allowedModes[0]);
    }
  }, [form, selectedAuthMode, selectedProvider]);

  const closeAuthProgress = async (forceCancel = false) => {
    if (addJob && addJob.status === 'running') {
      if (!forceCancel) {
        Modal.confirm({
          title: '取消当前授权流程？',
          content: `当前 ${addJob.provider}-${addJob.accountId} 仍在等待授权，取消后会释放占用并删除这次未完成的账号槽位。`,
          okText: '取消授权',
          cancelText: '继续等待',
          okButtonProps: { danger: true },
          onOk: async () => {
            await closeAuthProgress(true);
          }
        });
        return;
      }

      try {
        await accountsAPI.cancelAddJob(addJob.id);
        message.success('已取消当前授权流程');
        await loadAccounts();
      } catch (error: any) {
        message.error(error?.response?.data?.message || '取消授权失败');
        return;
      }
    }

    closeAuthProgressPanel();
  };

  const handleAdd = async (values: any) => {
    setSubmitting(true);
    const requestPayload = {
      provider: values.provider as Provider,
      authMode: values.authMode as AccountAuthMode,
      config: values.authMode === 'api-key'
        ? {
            apiKey: values.apiKey,
            baseUrl: values.baseUrl
          }
        : undefined
    };
    try {
      const result = await accountsAPI.add(requestPayload);

      setModalVisible(false);
      form.resetFields();

      if (result.jobId) {
        setAddJob({
          id: result.jobId,
          provider: result.provider,
          accountId: result.accountId,
          authMode: result.authMode,
          status: 'running',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          exitCode: null,
          logs: ''
        });
        setAddJobId(result.jobId);
        setAuthProgressVisible(true);
        message.info(`已创建 ${result.provider}-${result.accountId}，请完成授权`);
      } else {
        message.success('添加账号成功');
        loadAccounts();
      }
    } catch (error: any) {
      const code = error?.response?.data?.code;
      const existingJobId = error?.response?.data?.jobId;
      if (code === 'oauth_job_already_running' && existingJobId) {
        try {
          const retry = await accountsAPI.add({
            ...requestPayload,
            replaceExisting: true
          });
          setModalVisible(false);
          form.resetFields();
          if (retry.jobId) {
            setAddJob({
              id: retry.jobId,
              provider: retry.provider,
              accountId: retry.accountId,
              authMode: retry.authMode,
              status: 'running',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              exitCode: null,
              logs: ''
            });
            setAddJobId(retry.jobId);
            setAuthProgressVisible(true);
          }
          message.warning('检测到上一次未完成授权，已自动替换旧作业并重新开始');
          return;
        } catch (_retryError) {
          try {
            const job = await accountsAPI.getAddJob(existingJobId);
            setAddJob(job);
            setAddJobId(job.status === 'running' ? existingJobId : null);
            setAuthProgressVisible(true);
            setModalVisible(false);
            message.warning(`检测到 ${job.provider}-${job.accountId} 仍在授权中，已为你打开当前进度`);
            return;
          } catch (_innerError) {
            // fall through
          }
        }
      }
      message.error(error?.response?.data?.message || '添加账号失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (provider: string, accountId: string) => {
    try {
      await accountsAPI.delete(provider, accountId);
      message.success('删除账号成功');
      loadAccounts();
    } catch (_error) {
      message.error('删除账号失败');
    }
  };

  const handleReload = async () => {
    try {
      await managementAPI.reload();
      message.success('重新加载成功');
      loadAccounts();
    } catch (_error) {
      message.error('重新加载失败');
    }
  };

  // 按 Provider 分组统计
  const providerStats = useMemo(() => {
    const stats: Record<string, { total: number; healthy: number; exhausted: number }> = {
      all: { total: 0, healthy: 0, exhausted: 0 },
      codex: { total: 0, healthy: 0, exhausted: 0 },
      gemini: { total: 0, healthy: 0, exhausted: 0 },
      claude: { total: 0, healthy: 0, exhausted: 0 }
    };

    accounts.forEach(account => {
      const provider = account.provider;
      stats.all.total++;
      stats[provider].total++;

      if (account.configured && !account.exhausted) {
        stats.all.healthy++;
        stats[provider].healthy++;
      }

      if (account.exhausted) {
        stats.all.exhausted++;
        stats[provider].exhausted++;
      }
    });

    return stats;
  }, [accounts]);

  // 过滤账号
  const filteredAccounts = useMemo(() => {
    let filtered = accounts;

    // 按 provider 过滤
    if (activeProvider !== 'all') {
      filtered = filtered.filter(a => a.provider === activeProvider);
    }

    // 按状态过滤
    if (filterStatus === 'healthy') {
      filtered = filtered.filter(a => a.configured && !a.exhausted);
    } else if (filterStatus === 'exhausted') {
      filtered = filtered.filter(a => a.exhausted);
    } else if (filterStatus === 'unconfigured') {
      filtered = filtered.filter(a => !a.configured);
    }

    return filtered;
  }, [accounts, activeProvider, filterStatus]);

  const columns = [
    {
      title: '账号',
      dataIndex: 'displayName',
      key: 'displayName',
      width: 250,
      render: (_text: string, record: Account) => (
        <div>
          <div style={{ fontWeight: 'bold', marginBottom: 4 }}>
            {getAccountPrimaryLabel(record)}
          </div>
          <Space size="small" align="center">
            <ProviderIcon provider={record.provider} size={14} />
            <Tag color={
              record.planType === 'team' ? 'blue' :
              record.planType === 'plus' ? 'green' :
              record.planType === 'business' ? 'gold' :
              record.planType === 'api-key' ? 'cyan' :
              'default'
            } style={{ fontSize: 11, lineHeight: '18px', padding: '0 4px' }}>
              {record.planType || 'free'}
            </Tag>
            <span style={{ fontSize: 11, color: '#8c8c8c' }}>
              {record.apiKeyMode ? 'API Key' : 'OAuth'}
            </span>
          </Space>
        </div>
      )
    },
    {
      title: '认证类型',
      dataIndex: 'apiKeyMode',
      key: 'apiKeyMode',
      width: 100,
      render: (apiKeyMode: boolean) => (
        <Tag color={apiKeyMode ? 'blue' : 'green'}>
          {apiKeyMode ? 'API Key' : 'OAuth'}
        </Tag>
      )
    },
    {
      title: '配置状态',
      dataIndex: 'configured',
      key: 'configured',
      width: 100,
      render: (configured: boolean) => (
        <Tag
          icon={configured ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
          color={configured ? 'success' : 'default'}
        >
          {configured ? '已配置' : '未配置'}
        </Tag>
      )
    },
    {
      title: '运行状态',
      dataIndex: 'exhausted',
      key: 'exhausted',
      width: 140,
      render: (exhausted: boolean, record: Account) => {
        if (!record.configured) return <Tag color="default">未配置</Tag>;
        const runtimeStatus = String(record.runtimeStatus || '').trim();
        if (runtimeStatus && runtimeStatus !== 'healthy') {
          return <RuntimeStatusTag status={runtimeStatus} />;
        }
        return (
          <Tag
            icon={exhausted ? <CloseCircleOutlined /> : <CheckCircleOutlined />}
            color={exhausted ? 'error' : 'success'}
          >
            {exhausted ? '已耗尽' : '正常'}
          </Tag>
        );
      }
    },
    {
      title: '剩余额度',
      dataIndex: 'remainingPct',
      key: 'remainingPct',
      width: 260,
      sorter: (a: Account, b: Account) => (a.remainingPct || 0) - (b.remainingPct || 0),
      render: (_pct: number | null, record: Account) => <UsageSnapshotCell record={record} />
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 150,
      sorter: (a: Account, b: Account) => (a.updatedAt || 0) - (b.updatedAt || 0),
      render: (timestamp: number) => {
        if (!timestamp) return '-';
        return (
          <div>
            <div>{dayjs(timestamp).format('MM-DD HH:mm')}</div>
            <div style={{ fontSize: '12px', color: '#999' }}>
              {dayjs(timestamp).fromNow()}
            </div>
          </div>
        );
      }
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      fixed: 'right' as const,
      render: (_: any, record: Account) => {
        const menuItems: MenuProps['items'] = [
          {
            key: 'delete',
            label: '删除账号',
            danger: true,
            icon: <DeleteOutlined />
          }
        ];

        return (
          <Space>
            <Dropdown
              menu={{
                items: menuItems,
                onClick: ({ key }) => {
                  if (key === 'delete') {
                    Modal.confirm({
                      title: '确认删除？',
                      content: `删除后账号 ${record.displayName} 的所有数据都将被清除`,
                      okText: '确认',
                      cancelText: '取消',
                      okButtonProps: { danger: true },
                      onOk: () => handleDelete(record.provider, record.accountId)
                    });
                  }
                }
              }}
              trigger={['click']}
            >
              <Button icon={<MoreOutlined />} />
            </Dropdown>
          </Space>
        );
      }
    }
  ];

  const tabItems = [
    {
      key: 'all',
      label: <span style={{ padding: '0 8px' }}>全部 ({providerStats.all.total})</span>
    },
    {
      key: 'codex',
      label: (
        <span style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <ProviderIcon provider="codex" size={14} /> ChatGPT ({providerStats.codex.total})
        </span>
      )
    },
    {
      key: 'gemini',
      label: (
        <span style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <ProviderIcon provider="gemini" size={14} /> Gemini ({providerStats.gemini.total})
        </span>
      )
    },
    {
      key: 'claude',
      label: (
        <span style={{ padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <ProviderIcon provider="claude" size={14} /> Claude ({providerStats.claude.total})
        </span>
      )
    }
  ];

  const mobileAccounts = useMemo(() => {
    const healthyConfigured = accounts.filter((account) =>
      account.configured
      && !account.exhausted
      && (!account.runtimeStatus || account.runtimeStatus === 'healthy')
    );
    return healthyConfigured.length > 0
      ? healthyConfigured
      : accounts.filter((account) => account.configured && !account.exhausted);
  }, [accounts]);

  if (isMobile) {
    return (
      <div>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24 }}>账号</h1>
            <Text type="secondary" style={{ fontSize: 14, lineHeight: 1.65 }}>
              {hydratingDetails ? '基础列表已显示，详情正在后台补全。' : '这里只保留可用账号，方便手机快速查看。'}
            </Text>
          </div>
          <Button icon={<ReloadOutlined />} onClick={loadAccounts} loading={refreshing}>
            刷新
          </Button>
        </div>

        <Card style={{ marginBottom: 12, borderRadius: 18 }}>
          <Statistic
            title="可用账号"
            value={mobileAccounts.length}
            prefix={<CheckCircleOutlined />}
            valueStyle={{ color: '#1677ff' }}
          />
          <Space wrap size={[8, 8]} style={{ marginTop: 12 }}>
            {(['codex', 'gemini', 'claude'] as Provider[]).map((provider) => (
              <Tag key={provider} color="blue">
                <Space size={4}>
                  <ProviderIcon provider={provider} size={12} />
                  {provider}
                  <span>{mobileAccounts.filter((account) => account.provider === provider).length}</span>
                </Space>
              </Tag>
            ))}
          </Space>
        </Card>

        <Card title="OK 列表" style={{ borderRadius: 18 }}>
          {mobileAccounts.length === 0 ? (
            <Empty description="暂无可用账号" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <List
              dataSource={mobileAccounts}
              renderItem={(record) => (
                <List.Item style={{ padding: '12px 0' }}>
                  <div style={{ width: '100%' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <ProviderIcon provider={record.provider} size={16} />
                          <Text strong style={{ fontSize: 16, lineHeight: 1.45 }}>{getAccountPrimaryLabel(record)}</Text>
                        </div>
                        <div style={{ fontSize: 13, color: '#8c8c8c', lineHeight: 1.6 }}>
                          {getAccountMetaLabel(record)}
                        </div>
                        <div style={{ marginTop: 10, maxWidth: 220 }}>
                          <UsageSnapshotCell record={record} />
                        </div>
                      </div>
                      <div style={{ flexShrink: 0 }}>
                        <RuntimeStatusTag status={record.runtimeStatus || 'healthy'} fallback="OK" />
                      </div>
                    </div>
                  </div>
                </List.Item>
              )}
            />
          )}
        </Card>
      </div>
    );
  }

  return (
    <div>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ margin: 0 }}>账号管理</h1>
            {hydratingDetails ? (
              <Text type="secondary">基础列表已返回，账号详情正在后台增量补全。</Text>
            ) : null}
          </div>
          <Space>
            <Button icon={<ExportOutlined />} onClick={handleExport}>导出</Button>
            <Button icon={<ImportOutlined />} onClick={() => setImportModalVisible(true)}>导入</Button>
            <input ref={importInputRef} type="file" accept=".json,.jsonl" style={{ display: 'none' }} onChange={handleImport} />
            <Button icon={<ReloadOutlined />} onClick={loadAccounts} loading={refreshing}>刷新</Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                form.setFieldsValue({
                  provider: 'codex',
                  authMode: 'oauth-browser'
                });
                setModalVisible(true);
              }}
            >
              添加账号
            </Button>
          </Space>
        </div>

      {/* 统计卡片 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card>
            <Statistic
              title="总账号数"
              value={providerStats[activeProvider].total}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="健康账号"
              value={providerStats[activeProvider].healthy}
              valueStyle={{ color: '#3f8600' }}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="已耗尽"
              value={providerStats[activeProvider].exhausted}
              valueStyle={{ color: '#cf1322' }}
              prefix={<CloseCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="可用率"
              value={providerStats[activeProvider].total > 0
                ? Math.round((providerStats[activeProvider].healthy / providerStats[activeProvider].total) * 100)
                : 0
              }
              suffix="%"
              valueStyle={{
                color: providerStats[activeProvider].total > 0 &&
                  (providerStats[activeProvider].healthy / providerStats[activeProvider].total) > 0.5
                  ? '#3f8600' : '#cf1322'
              }}
            />
          </Card>
        </Col>
      </Row>

      <Modal
        title="导入账号"
        open={importModalVisible}
        onOk={handleImportSubmit}
        onCancel={() => setImportModalVisible(false)}
        okText="导入"
        cancelText="取消"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Segmented
            value={importMode}
            onChange={(value) => setImportMode(value as 'file' | 'path' | 'text')}
            options={[
              { label: 'JSON 文件', value: 'file' },
              { label: '本地路径', value: 'path' },
              { label: '手动粘贴', value: 'text' }
            ]}
          />
          {importMode === 'file' ? (
            <Alert
              type="info"
              showIcon
              message="支持上传 JSON / JSONL。zip 或目录请改用“本地路径”方式。"
              action={<Button size="small" onClick={() => importInputRef.current?.click()}>选择文件</Button>}
            />
          ) : null}
          {importMode === 'path' ? (
            <Input
              placeholder="/absolute/path/to/folder-or-zip-or-json"
              value={importPath}
              onChange={(e) => setImportPath(e.target.value)}
            />
          ) : null}
          {importMode === 'text' ? (
            <Input.TextArea
              rows={10}
              placeholder="粘贴单账号 JSON、bundle JSON，或多行 JSONL"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
          ) : null}
        </div>
      </Modal>

      <Card>
        <Tabs
          activeKey={activeProvider}
          onChange={setActiveProvider}
          items={tabItems}
          tabBarExtraContent={
            <Space>
              <Select
                value={filterStatus}
                onChange={setFilterStatus}
                style={{ width: 120 }}
                options={[
                  { label: '全部状态', value: 'all' },
                  { label: '健康', value: 'healthy' },
                  { label: '已耗尽', value: 'exhausted' },
                  { label: '未配置', value: 'unconfigured' }
                ]}
                suffixIcon={<FilterOutlined />}
              />
              <Button
                icon={<SyncOutlined />}
                onClick={handleReload}
                loading={refreshing}
              >
                重新加载
              </Button>
            </Space>
          }
        />

        <Table
          dataSource={filteredAccounts}
          columns={columns}
          rowKey={(record) => `${record.provider}-${record.accountId}`}
          loading={loading}
          pagination={{
            pageSize: 20,
            showTotal: (total) => `共 ${total} 个账号`,
            showSizeChanger: true,
            showQuickJumper: true
          }}
          scroll={{ x: 1200 }}
        />
      </Card>

      <Modal
        title="添加新账号"
        open={modalVisible}
        onOk={() => form.submit()}
        onCancel={() => {
          setModalVisible(false);
          form.resetFields();
        }}
        confirmLoading={submitting}
        okText="确定"
        cancelText="取消"
        width={600}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleAdd}
        >
          <Form.Item
            name="provider"
            label="Provider"
            rules={[{ required: true, message: '请选择 Provider' }]}
          >
            <Select placeholder="选择 Provider" size="large">
              <Select.Option value="codex">
                <Space align="center">
                  <ProviderIcon provider="codex" size={18} />
                  <span>ChatGPT (OpenAI)</span>
                </Space>
              </Select.Option>
              <Select.Option value="gemini">
                <Space align="center">
                  <ProviderIcon provider="gemini" size={18} />
                  <span>Gemini (Google)</span>
                </Space>
              </Select.Option>
              <Select.Option value="claude">
                <Space align="center">
                  <ProviderIcon provider="claude" size={18} />
                  <span>Claude (Anthropic)</span>
                </Space>
              </Select.Option>
            </Select>
          </Form.Item>

          <Form.Item
            name="authMode"
            label="认证方式"
            rules={[{ required: true, message: '请选择认证方式' }]}
          >
            <Radio.Group size="large">
              <Space direction="vertical">
                {providerAuthOptions.map((option) => (
                  <Radio key={option.value} value={option.value}>
                    <Space direction="vertical" size={0}>
                      <span>{option.label}</span>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {option.description}
                      </Text>
                    </Space>
                  </Radio>
                ))}
              </Space>
            </Radio.Group>
          </Form.Item>

          {providerCapabilityHint ? (
            <Alert
              type="info"
              showIcon
              message="当前可接入范围"
              description={providerCapabilityHint}
              style={{ marginBottom: 16 }}
            />
          ) : null}

          {unavailableAuthOptions.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message="以下认证方式暂不提供入口"
              description={
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {unavailableAuthOptions.map((option) => (
                    <div key={option.label}>
                      <Text strong>{option.label}</Text>
                      <br />
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {option.description}
                      </Text>
                    </div>
                  ))}
                </Space>
              }
              style={{ marginBottom: 16 }}
            />
          ) : null}

          {selectedAuthMode !== 'api-key' ? (
            <Alert
              type="info"
              showIcon
              message="系统会自动分配账号编号"
              description={
                selectedAuthMode === 'oauth-browser'
                  ? '将直接启动 Provider 原生 OAuth 浏览器授权流程。'
                  : '将启动更适合远程环境的设备码授权流程，你可以在下面的进度弹窗里看到验证码和链接。'
              }
            />
          ) : (
            <>
              <Form.Item
                name="apiKey"
                label="API Key"
                rules={[{ required: true, message: '请输入 API Key' }]}
              >
                <Input.Password placeholder="请输入 API Key" size="large" />
              </Form.Item>

              {selectedProvider !== 'gemini' && (
                <Form.Item
                  name="baseUrl"
                  label="Base URL（可选）"
                  help="用于中转服务或自定义网关"
                >
                  <Input placeholder="https://api.example.com" size="large" />
                </Form.Item>
              )}
            </>
          )}
        </Form>
      </Modal>

      <Modal
        title="OAuth 授权进度"
        open={authProgressVisible}
        footer={[
          <Button
            key="close"
            onClick={() => closeAuthProgress(false)}
          >
            {addJob?.status === 'running' ? '关闭 / 取消' : '关闭'}
          </Button>
        ]}
        onCancel={() => closeAuthProgress(false)}
        width={760}
      >
        {addJob ? (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Alert
              type={
                addJob.status === 'failed'
                  ? 'error'
                  : addJob.status === 'succeeded'
                    ? 'success'
                    : addJob.status === 'expired'
                      ? 'warning'
                    : addJob.status === 'cancelled'
                      ? 'warning'
                      : 'info'
              }
              showIcon
              message={`${addJob.provider}-${addJob.accountId}`}
              description={
                addJob.status === 'running'
                  ? '正在等待授权完成...'
                  : addJob.status === 'succeeded'
                    ? '授权已完成，账号已经可用。'
                    : addJob.status === 'expired'
                      ? (addJob.error || '授权已过期，请重新发起。')
                    : addJob.status === 'cancelled'
                      ? (addJob.error || '授权流程已取消。')
                      : (addJob.error || '授权失败，请查看下方日志。')
              }
            />

            {(addJob.expiresAt || addJob.pollIntervalMs) && (
              <Card size="small" title="授权状态">
                {addJob.expiresAt ? (
                  <Paragraph>
                    <Text strong>过期时间：</Text> {dayjs(addJob.expiresAt).format('YYYY-MM-DD HH:mm:ss')}
                  </Paragraph>
                ) : null}
                {addJob.pollIntervalMs ? (
                  <Paragraph>
                    <Text strong>建议轮询间隔：</Text> {Math.round(addJob.pollIntervalMs / 1000)} 秒
                  </Paragraph>
                ) : null}
              </Card>
            )}

            {(addJob.userCode || addJob.verificationUri || addJob.verificationUriComplete) && (
              <Card size="small" title="设备码信息">
                {addJob.userCode && (
                  <Paragraph copyable={{ text: addJob.userCode }}>
                    <Text strong>验证码：</Text> {addJob.userCode}
                  </Paragraph>
                )}
                {addJob.verificationUri && (
                  <Paragraph copyable={{ text: addJob.verificationUri }}>
                    <Text strong>验证地址：</Text> {addJob.verificationUri}
                  </Paragraph>
                )}
                {addJob.verificationUriComplete && addJob.verificationUriComplete !== addJob.verificationUri && (
                  <Paragraph copyable={{ text: addJob.verificationUriComplete }}>
                    <Text strong>完整链接：</Text> {addJob.verificationUriComplete}
                  </Paragraph>
                )}
              </Card>
            )}

            <Card size="small" title="授权日志">
              <pre
                style={{
                  margin: 0,
                  maxHeight: 320,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: 12,
                  lineHeight: 1.5
                }}
              >
                {addJob.logs || '等待 Provider 返回授权输出...'}
              </pre>
            </Card>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
};

export default Accounts;
