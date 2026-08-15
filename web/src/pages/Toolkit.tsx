import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Tabs,
  Tag,
  Space,
  Segmented,
  Tooltip,
  message,
  Input,
  Typography,
  Spin,
  Alert,
  Modal
} from 'antd';
import {
  AppstoreOutlined,
  CodeOutlined,
  CloudSyncOutlined,
  GlobalOutlined,
  ReloadOutlined,
  DownloadOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ThunderboltOutlined,
  ApiOutlined,
  ToolOutlined,
  ForkOutlined,
  EditOutlined,
  LockOutlined
} from '@ant-design/icons';
import { ProCard, StatisticCard } from '@ant-design/pro-components';
import PageScaffold from '@/components/ui/PageScaffold';
import Button from '@/components/ui/AppButton';
import ProviderIcon from '@/components/chat/ProviderIcon';
import ProxyPoolPanel from '@/components/toolkit/proxy-pool/ProxyPoolPanel';
import ManagedToolsPanel from '@/components/toolkit/ManagedToolsPanel';
import { toolkitAPI } from '@/services/api';
import type {
  ManagedAppItem,
  ManagedAppsResponse,
  EnvironmentsResponse,
  MirrorsResponse,
  ProxyStatusResponse,
  ConnectivityResponse,
  Provider,
  ToolkitAppConfigResponse
} from '@/types';
import './Toolkit.css';

const { Text, Title, Paragraph } = Typography;

export default function Toolkit() {
  const [activeTab, setActiveTab] = useState<string>('apps');
  const [loading, setLoading] = useState<boolean>(false);

  // Data states
  const [appsData, setAppsData] = useState<ManagedAppsResponse | null>(null);
  const [envData, setEnvData] = useState<EnvironmentsResponse | null>(null);
  const [mirrorsData, setMirrorsData] = useState<MirrorsResponse | null>(null);
  const [proxyData, setProxyData] = useState<ProxyStatusResponse | null>(null);
  const [connectivityData, setConnectivityData] = useState<ConnectivityResponse | null>(null);

  // App category filter
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');

  // Action states
  const [installingApp, setInstallingApp] = useState<string | null>(null);
  const [installingHooks, setInstallingHooks] = useState<boolean>(false);
  const [settingMirror, setSettingMirror] = useState<string | null>(null);
  const [pingResults, setPingResults] = useState<Record<string, number>>({});
  const [pingingUrls, setPingingUrls] = useState<Record<string, boolean>>({});
  const [testingConnectivity, setTestingConnectivity] = useState<boolean>(false);
  const [editingConfigApp, setEditingConfigApp] = useState<ManagedAppItem | null>(null);
  const [configData, setConfigData] = useState<ToolkitAppConfigResponse | null>(null);
  const [configContent, setConfigContent] = useState<string>('');
  const [configLoading, setConfigLoading] = useState<boolean>(false);
  const [savingConfig, setSavingConfig] = useState<boolean>(false);

  // Fetch Apps
  const fetchApps = useCallback(async () => {
    setLoading(true);
    try {
      const res = await toolkitAPI.listApps();
      if (res.ok) setAppsData(res);
    } catch (e: any) {
      message.error(e.message || '获取应用列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch Environments
  const fetchEnv = useCallback(async () => {
    setLoading(true);
    try {
      const res = await toolkitAPI.getEnvironments();
      if (res.ok) setEnvData(res);
    } catch (e: any) {
      message.error(e.message || '获取环境信息失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch Mirrors
  const fetchMirrors = useCallback(async () => {
    setLoading(true);
    try {
      const res = await toolkitAPI.getMirrors();
      if (res.ok) setMirrorsData(res);
    } catch (e: any) {
      message.error(e.message || '获取镜像源失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch Proxy
  const fetchProxy = useCallback(async () => {
    setLoading(true);
    try {
      const res = await toolkitAPI.getProxy();
      if (res.ok) setProxyData(res);
    } catch (e: any) {
      message.error(e.message || '获取代理信息失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch initial data based on active tab
  useEffect(() => {
    if (activeTab === 'apps') fetchApps();
    else if (activeTab === 'env') fetchEnv();
    else if (activeTab === 'mirrors') fetchMirrors();
    else if (activeTab === 'proxy') {
      fetchProxy();
      handleTestConnectivity();
    }
  }, [activeTab, fetchApps, fetchEnv, fetchMirrors, fetchProxy]);

  // Install app handler
  const handleInstallApp = async (provider: string) => {
    setInstallingApp(provider);
    try {
      const res = await toolkitAPI.installApp(provider);
      if (res.ok && res.result?.installed) {
        message.success(`${provider} 安装成功`);
        fetchApps();
      } else {
        message.error(`安装失败：${res.result?.installAttempts?.[0]?.error || '未知错误'}`);
      }
    } catch (e: any) {
      message.error(e.message || '安装请求失败');
    } finally {
      setInstallingApp(null);
    }
  };

  // Install all official hooks
  const handleInstallHooks = async () => {
    if (!appsData) return;
    setInstallingHooks(true);
    const providersWithHook = appsData.apps
      .filter((a) => a.hookSupported && !a.hookInstalled)
      .map((a) => a.provider);

    if (!providersWithHook.length) {
      message.info('所有应用官方 Hook 均已安装就绪');
      setInstallingHooks(false);
      return;
    }

    try {
      const res = await toolkitAPI.installHooks(providersWithHook);
      if (res.ok) {
        message.success('已批量配置并启用官方 Hook');
        fetchApps();
      }
    } catch (e: any) {
      message.error(e.message || 'Hook 安装失败');
    } finally {
      setInstallingHooks(false);
    }
  };

  // Set Mirror handler
  const handleSetMirror = async (type: 'npm' | 'pip', url: string) => {
    setSettingMirror(url);
    try {
      const res = await toolkitAPI.setMirror(type, url);
      if (res.ok) {
        message.success(`已切换 ${type.toUpperCase()} 镜像源`);
        fetchMirrors();
      } else {
        message.error(`切换失败: ${res.error}`);
      }
    } catch (e: any) {
      message.error(e.message || '切换镜像源请求失败');
    } finally {
      setSettingMirror(null);
    }
  };

  // Ping Mirror
  const handlePingMirror = async (url: string) => {
    setPingingUrls((prev) => ({ ...prev, [url]: true }));
    try {
      const res = await toolkitAPI.pingMirror(url);
      if (res.ok) {
        setPingResults((prev) => ({ ...prev, [url]: res.latencyMs }));
      } else {
        setPingResults((prev) => ({ ...prev, [url]: -1 }));
      }
    } catch (_e) {
      setPingResults((prev) => ({ ...prev, [url]: -1 }));
    } finally {
      setPingingUrls((prev) => ({ ...prev, [url]: false }));
    }
  };

  // Test Connectivity
  const handleTestConnectivity = async () => {
    setTestingConnectivity(true);
    try {
      const res = await toolkitAPI.testConnectivity();
      if (res.ok) setConnectivityData(res);
    } catch (e: any) {
      message.error(e.message || '网络测速失败');
    } finally {
      setTestingConnectivity(false);
    }
  };

  const getRequestErrorMessage = (error: any, fallback: string) => (
    error?.response?.data?.message || error?.response?.data?.error || error?.message || fallback
  );

  const handleOpenConfigEditor = async (app: ManagedAppItem) => {
    setEditingConfigApp(app);
    setConfigData(null);
    setConfigContent('');
    setConfigLoading(true);
    try {
      const data = await toolkitAPI.getAppConfig(app.id);
      setConfigData(data);
      setConfigContent(data.content || '');
    } catch (error: any) {
      setEditingConfigApp(null);
      message.error(getRequestErrorMessage(error, '读取配置失败'));
    } finally {
      setConfigLoading(false);
    }
  };

  const handleSaveConfig = async () => {
    if (!editingConfigApp || !configData) return;
    setSavingConfig(true);
    try {
      const result = await toolkitAPI.saveAppConfig(
        editingConfigApp.id,
        configContent,
        configData.revision
      );
      setConfigData(result);
      message.success(result.elevated ? '配置已通过系统授权保存' : '配置已保存');
      fetchApps();
    } catch (error: any) {
      message.error(getRequestErrorMessage(error, '保存配置失败'));
    } finally {
      setSavingConfig(false);
    }
  };

  // Filtered Apps
  const filteredApps = useMemo(() => {
    if (!appsData) return [];
    if (categoryFilter === 'ALL') return appsData.apps;
    return appsData.apps.filter((a) => a.categories.includes(categoryFilter));
  }, [appsData, categoryFilter]);

  // Render Latency Tag helper
  const renderLatencyTag = (ms: number | undefined) => {
    if (ms === undefined) return null;
    if (ms < 0) return <Tag color="error">超时/不可达</Tag>;
    if (ms < 200) return <Tag color="success">{ms}ms 极速</Tag>;
    if (ms < 600) return <Tag color="warning">{ms}ms 良好</Tag>;
    return <Tag color="error">{ms}ms 较慢</Tag>;
  };

  return (
    <PageScaffold
      title="开发工具"
      eyebrow="Toolkit"
      description="统一管理 AI 应用、会话运行时、网络隧道、Node/Python 环境、镜像加速与代理网络。"
      actions={
        <Space>
          <Button
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => {
              if (activeTab === 'apps') fetchApps();
              else if (activeTab === 'env') fetchEnv();
              else if (activeTab === 'mirrors') fetchMirrors();
              else if (activeTab === 'proxy') {
                fetchProxy();
                handleTestConnectivity();
              }
            }}
          >
            刷新
          </Button>
        </Space>
      }
    >
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'apps',
            label: (
              <span>
                <AppstoreOutlined /> 应用管理
              </span>
            ),
            children: (
              <div className="toolkit-page">
                {/* 顶部统计卡片 */}
                <div className="toolkit-stat-row">
                  <StatisticCard.Group direction="row">
                    <StatisticCard
                      statistic={{
                        title: '应用总数',
                        value: appsData?.total || 0,
                        icon: <AppstoreOutlined style={{ color: '#1677ff', fontSize: 24 }} />
                      }}
                    />
                    <StatisticCard
                      statistic={{
                        title: '已安装就绪',
                        value: appsData?.installedCount || 0,
                        valueStyle: { color: '#52c41a' },
                        icon: <CheckCircleOutlined style={{ color: '#52c41a', fontSize: 24 }} />
                      }}
                    />
                    <StatisticCard
                      statistic={{
                        title: '未安装',
                        value: (appsData?.total || 0) - (appsData?.installedCount || 0),
                        valueStyle: { color: '#faad14' },
                        icon: <DownloadOutlined style={{ color: '#faad14', fontSize: 24 }} />
                      }}
                    />
                  </StatisticCard.Group>
                </div>

                {/* 分类过滤器与全局操作 */}
                <div className="toolkit-category-bar">
                  <Segmented
                    value={categoryFilter}
                    onChange={(val) => setCategoryFilter(val as string)}
                    options={[
                      { label: '全部 (ALL)', value: 'ALL' },
                      { label: 'CLI 编程工具', value: 'CLI Code' },
                      { label: '桌面客户端', value: 'Desktop' },
                      { label: 'IDE 插件/扩展', value: 'IDE' },
                      { label: '自主 Agent', value: 'Agents' }
                    ]}
                  />

                  <Space>
                    <Button
                      type="primary"
                      icon={<CloudSyncOutlined />}
                      loading={installingHooks}
                      onClick={handleInstallHooks}
                    >
                      一键启用所有官方 Hook
                    </Button>
                  </Space>
                </div>

                {/* 应用卡片网格 */}
                {loading && !appsData ? (
                  <div style={{ textAlign: 'center', padding: '60px 0' }}>
                    <Spin size="large" />
                  </div>
                ) : (
                  <div className="toolkit-grid">
                    {filteredApps.map((app) => (
                      <div
                        key={app.id}
                        className={`toolkit-app-card ${app.installed ? 'installed' : 'uninstalled'}`}
                      >
                        <div>
                          <div className="toolkit-card-header">
                            <div className="toolkit-card-title-group">
                              <ProviderIcon provider={app.provider as Provider} size={28} />
                              <div>
                                <h3 className="toolkit-card-title">{app.name}</h3>
                                <Space size={4} style={{ marginTop: 2 }}>
                                  <Tag color={app.installed ? 'success' : 'default'} style={{ margin: 0 }}>
                                    {app.installed ? '已安装' : '未安装'}
                                  </Tag>
                                  {app.hookSupported && (
                                    <Tag color={app.hookInstalled ? 'blue' : 'warning'} style={{ margin: 0 }}>
                                      {app.hookInstalled ? 'Hook 就绪' : 'Hook 待配'}
                                    </Tag>
                                  )}
                                </Space>
                              </div>
                            </div>
                          </div>

                          <div className="toolkit-card-body">
                            <div className="toolkit-detail-row">
                              <span className="toolkit-detail-label">版本:</span>
                              <span className="toolkit-detail-value">{app.version || '-'}</span>
                            </div>
                            <div className="toolkit-detail-row">
                              <span className="toolkit-detail-label">主模型:</span>
                              <span className="toolkit-detail-value">{app.defaultModel || '-'}</span>
                            </div>
                            <div className="toolkit-detail-row">
                              <span className="toolkit-detail-label">程序路径:</span>
                              <Tooltip title={app.cliPath || '未探测到可执行路径'}>
                                <span className="toolkit-detail-value">{app.cliPath || '-'}</span>
                              </Tooltip>
                            </div>
                            <div className="toolkit-detail-row">
                              <span className="toolkit-detail-label">配置:</span>
                              <span className="toolkit-detail-value">
                                {app.configExists ? `${app.configName} 已存在` : `${app.configName || '默认配置'} 待创建`}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="toolkit-card-actions">
                          <Space size={8}>
                            {app.type === 'cli' && (
                              <Button
                                size="small"
                                type={app.installed ? 'default' : 'primary'}
                                icon={<DownloadOutlined />}
                                loading={installingApp === app.id}
                                onClick={() => handleInstallApp(app.id)}
                              >
                                {app.installed ? '更新 / 修复' : '一键安装'}
                              </Button>
                            )}

                            {app.hookSupported && !app.hookInstalled && (
                              <Button
                                size="small"
                                icon={<CloudSyncOutlined />}
                                onClick={() => {
                                  toolkitAPI.installHooks([app.provider]).then(() => {
                                    message.success(`已为 ${app.name} 启用官方 Hook`);
                                    fetchApps();
                                  });
                                }}
                              >
                                启用 Hook
                              </Button>
                            )}

                            {app.configName && (
                              <Button
                                size="small"
                                icon={<EditOutlined />}
                                onClick={() => handleOpenConfigEditor(app)}
                              >
                                编辑配置
                              </Button>
                            )}
                          </Space>

                          <Text type="secondary" style={{ fontSize: 11 }}>
                            {app.syncMode === 'hook' ? '⚡ 事件驱动' : '🔄 自动轮询'}
                          </Text>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          },
          {
            key: 'session-runtimes',
            label: (
              <span>
                <ToolOutlined /> 会话运行时
              </span>
            ),
            children: <ManagedToolsPanel category="session-runtimes" />
          },
          {
            key: 'network-access',
            label: (
              <span>
                <ApiOutlined /> 网络接入与隧道
              </span>
            ),
            children: <ManagedToolsPanel category="network-access" />
          },
          {
            key: 'env',
            label: (
              <span>
                <CodeOutlined /> 运行环境 (Node / Python)
              </span>
            ),
            children: (
              <div className="toolkit-page">
                <ProCard title="Node.js 运行环境与版本管理" headerBordered className="toolkit-env-card">
                  <div style={{ marginBottom: 16 }}>
                    <Paragraph>
                      Node.js 当前活动版本：
                      <Tag color="green" style={{ fontSize: 14, padding: '2px 8px' }}>
                        {envData?.environments.node.currentVersion || '未检测到'}
                      </Tag>
                      路径：<code>{envData?.environments.node.activePath}</code>
                    </Paragraph>
                  </div>

                  <div style={{ marginBottom: 20 }}>
                    <Title level={5}>包管理器 (Package Managers)</Title>
                    <Space size={16} wrap>
                      <Tag color="cyan">npm: {envData?.environments.node.packageManagers?.npm || '未安装'}</Tag>
                      <Tag color="blue">pnpm: {envData?.environments.node.packageManagers?.pnpm || '未安装'}</Tag>
                      <Tag color="purple">yarn: {envData?.environments.node.packageManagers?.yarn || '未安装'}</Tag>
                      <Tag color="gold">bun: {envData?.environments.node.packageManagers?.bun || '未安装'}</Tag>
                    </Space>
                  </div>

                  <div>
                    <Title level={5}>环境多版本管理工具 (nvm / fnm / volta)</Title>
                    {envData?.environments.node.versionManagers && envData.environments.node.versionManagers.length > 0 ? (
                      <Space orientation="vertical" style={{ width: '100%' }}>
                        {envData.environments.node.versionManagers.map((mgr) => (
                          <Alert
                            key={mgr.name}
                            type="info"
                            showIcon
                            message={
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span>
                                  <strong>{mgr.name.toUpperCase()}</strong> 已就绪 (目录: <code>{mgr.path}</code>)
                                </span>
                                {mgr.versions && (
                                  <span>已安装版本: {mgr.versions.map((v) => <Tag key={v}>{v}</Tag>)}</span>
                                )}
                              </div>
                            }
                          />
                        ))}
                      </Space>
                    ) : (
                      <Alert type="warning" showIcon message="未检测到 nvm / fnm 多版本管理目录，当前使用系统单一全局 Node 环境。" />
                    )}
                  </div>
                </ProCard>

                <ProCard title="Python 运行环境与虚拟环境" headerBordered className="toolkit-env-card">
                  <div style={{ marginBottom: 16 }}>
                    <Paragraph>
                      Python 当前版本：
                      <Tag color="blue" style={{ fontSize: 14, padding: '2px 8px' }}>
                        {envData?.environments.python.currentVersion || '未检测到'}
                      </Tag>
                      pip 版本：<Tag color="geekblue">{envData?.environments.python.pip || '未检测到'}</Tag>
                      路径：<code>{envData?.environments.python.activePath}</code>
                    </Paragraph>
                  </div>

                  <div>
                    <Title level={5}>虚拟环境与多版本工具 (pyenv / conda)</Title>
                    {envData?.environments.python.versionManagers && envData.environments.python.versionManagers.length > 0 ? (
                      <Space orientation="vertical" style={{ width: '100%' }}>
                        {envData.environments.python.versionManagers.map((mgr) => (
                          <Alert
                            key={mgr.name}
                            type="info"
                            showIcon
                            message={
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span>
                                  <strong>{mgr.name.toUpperCase()}</strong> 已就绪
                                </span>
                                {mgr.versions && (
                                  <span>已安装环境: {mgr.versions.map((v) => <Tag key={v}>{v}</Tag>)}</span>
                                )}
                              </div>
                            }
                          />
                        ))}
                      </Space>
                    ) : (
                      <Alert type="warning" showIcon message="未检测到 pyenv / conda 虚拟环境，当前使用全局 Python 环境。" />
                    )}
                  </div>
                </ProCard>
              </div>
            )
          },
          {
            key: 'mirrors',
            label: (
              <span>
                <ThunderboltOutlined /> 镜像加速与包源 (Mirrors)
              </span>
            ),
            children: (
              <div className="toolkit-page">
                {/* npm Mirrors */}
                <ProCard
                  title="npm 镜像加速源 (npm Registry)"
                  subTitle={`当前生效: ${mirrorsData?.npm.current || '-'}`}
                  headerBordered
                  className="toolkit-env-card"
                >
                  <Space orientation="vertical" style={{ width: '100%' }}>
                    {mirrorsData?.npm.presets.map((preset) => {
                      const isActive = Boolean(preset.active);
                      const latency = pingResults[preset.url];
                      const isPinging = pingingUrls[preset.url];

                      return (
                        <div key={preset.id} className={`toolkit-mirror-row ${isActive ? 'active' : ''}`}>
                          <div>
                            <Space size={8}>
                              <strong>{preset.name}</strong>
                              {preset.official && <Tag color="blue">官方</Tag>}
                              {isActive && <Tag color="success">当前生效</Tag>}
                              {renderLatencyTag(latency)}
                            </Space>
                            <div style={{ marginTop: 4 }}>
                              <Text type="secondary" code>{preset.url}</Text>
                            </div>
                          </div>

                          <Space size={8}>
                            <Button
                              size="small"
                              loading={isPinging}
                              onClick={() => handlePingMirror(preset.url)}
                            >
                              测速
                            </Button>
                            <Button
                              size="small"
                              type={isActive ? 'default' : 'primary'}
                              disabled={isActive}
                              loading={settingMirror === preset.url}
                              onClick={() => handleSetMirror('npm', preset.url)}
                            >
                              {isActive ? '使用中' : '设为当前源'}
                            </Button>
                          </Space>
                        </div>
                      );
                    })}
                  </Space>
                </ProCard>

                {/* pip Mirrors */}
                <ProCard
                  title="Python pip 镜像加速源 (PyPI Index)"
                  subTitle={`当前生效: ${mirrorsData?.pip.current || '-'}`}
                  headerBordered
                  className="toolkit-env-card"
                >
                  <Space orientation="vertical" style={{ width: '100%' }}>
                    {mirrorsData?.pip.presets.map((preset) => {
                      const isActive = Boolean(preset.active);
                      const latency = pingResults[preset.url];
                      const isPinging = pingingUrls[preset.url];

                      return (
                        <div key={preset.id} className={`toolkit-mirror-row ${isActive ? 'active' : ''}`}>
                          <div>
                            <Space size={8}>
                              <strong>{preset.name}</strong>
                              {preset.official && <Tag color="blue">官方</Tag>}
                              {isActive && <Tag color="success">当前生效</Tag>}
                              {renderLatencyTag(latency)}
                            </Space>
                            <div style={{ marginTop: 4 }}>
                              <Text type="secondary" code>{preset.url}</Text>
                            </div>
                          </div>

                          <Space size={8}>
                            <Button
                              size="small"
                              loading={isPinging}
                              onClick={() => handlePingMirror(preset.url)}
                            >
                              测速
                            </Button>
                            <Button
                              size="small"
                              type={isActive ? 'default' : 'primary'}
                              disabled={isActive}
                              loading={settingMirror === preset.url}
                              onClick={() => handleSetMirror('pip', preset.url)}
                            >
                              {isActive ? '使用中' : '设为当前源'}
                            </Button>
                          </Space>
                        </div>
                      );
                    })}
                  </Space>
                </ProCard>
              </div>
            )
          },
          {
            key: 'proxy-pool',
            label: (
              <span>
                <ForkOutlined /> 代理池与分流 (Proxy Pool)
              </span>
            ),
            children: (
              <div className="toolkit-page">
                <ProxyPoolPanel />
              </div>
            )
          },
          {
            key: 'proxy',
            label: (
              <span>
                <GlobalOutlined /> 网络与代理诊断 (Proxy & Network)
              </span>
            ),
            children: (
              <div className="toolkit-page">
                {/* 连通性测试 */}
                <ProCard
                  title="AI 端点与核心服务网络连通性"
                  headerBordered
                  className="toolkit-env-card"
                  extra={
                    <Button
                      icon={<ThunderboltOutlined />}
                      loading={testingConnectivity}
                      onClick={handleTestConnectivity}
                    >
                      重新检测连通性
                    </Button>
                  }
                >
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
                    {connectivityData?.results.map((target) => (
                      <div
                        key={target.id}
                        style={{
                          border: '1px solid #f0f0f0',
                          borderRadius: 8,
                          padding: 12,
                          background: target.reachable ? 'rgba(82, 196, 26, 0.04)' : 'rgba(255, 77, 79, 0.04)'
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                          <strong>{target.name}</strong>
                          {target.reachable ? (
                            <Tag color="success"><CheckCircleOutlined /> 可直连</Tag>
                          ) : (
                            <Tag color="error"><CloseCircleOutlined /> 无法连接</Tag>
                          )}
                        </div>
                        <Text type="secondary" code style={{ fontSize: 12 }}>{target.host}</Text>
                        <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 12, color: '#999' }}>延迟响应:</span>
                          {renderLatencyTag(target.latencyMs)}
                        </div>
                      </div>
                    ))}
                  </div>
                </ProCard>

                {/* 环境变量代理与工具代理 */}
                <ProCard title="代理设置与环境变量 (Proxy Config)" headerBordered className="toolkit-env-card">
                  <div style={{ marginBottom: 16 }}>
                    <Title level={5}>系统环境变量代理</Title>
                    <Space size={16} wrap>
                      <Tag>HTTP_PROXY: {proxyData?.env.httpProxy || '未设置'}</Tag>
                      <Tag>HTTPS_PROXY: {proxyData?.env.httpsProxy || '未设置'}</Tag>
                      <Tag>ALL_PROXY: {proxyData?.env.allProxy || '未设置'}</Tag>
                      <Tag>NO_PROXY: {proxyData?.env.noProxy || '未设置'}</Tag>
                    </Space>
                  </div>

                  <div style={{ marginTop: 20 }}>
                    <Title level={5}>Git 全局代理 (git config --global http.proxy)</Title>
                    <Space>
                      <Input
                        style={{ width: 320 }}
                        placeholder="http://127.0.0.1:7890"
                        defaultValue={proxyData?.tools.git.httpProxy}
                        id="git-proxy-input"
                      />
                      <Button
                        type="primary"
                        onClick={() => {
                          const input = (document.getElementById('git-proxy-input') as HTMLInputElement)?.value;
                          toolkitAPI.setProxy('git', input).then(() => {
                            message.success('已更新 Git 全局代理');
                            fetchProxy();
                          });
                        }}
                      >
                        保存 Git 代理
                      </Button>
                      <Button
                        onClick={() => {
                          toolkitAPI.setProxy('git', '').then(() => {
                            message.success('已清除 Git 全局代理');
                            fetchProxy();
                          });
                        }}
                      >
                        清除
                      </Button>
                    </Space>
                  </div>

                  <div style={{ marginTop: 20 }}>
                    <Title level={5}>npm 全局代理 (npm config set proxy)</Title>
                    <Space>
                      <Input
                        style={{ width: 320 }}
                        placeholder="http://127.0.0.1:7890"
                        defaultValue={proxyData?.tools.npm.httpProxy}
                        id="npm-proxy-input"
                      />
                      <Button
                        type="primary"
                        onClick={() => {
                          const input = (document.getElementById('npm-proxy-input') as HTMLInputElement)?.value;
                          toolkitAPI.setProxy('npm', input).then(() => {
                            message.success('已更新 npm 全局代理');
                            fetchProxy();
                          });
                        }}
                      >
                        保存 npm 代理
                      </Button>
                      <Button
                        onClick={() => {
                          toolkitAPI.setProxy('npm', '').then(() => {
                            message.success('已清除 npm 全局代理');
                            fetchProxy();
                          });
                        }}
                      >
                        清除
                      </Button>
                    </Space>
                  </div>
                </ProCard>
              </div>
            )
          }
        ]}
      />

      <Modal
        open={Boolean(editingConfigApp)}
        title={editingConfigApp ? `编辑 ${editingConfigApp.name} 配置` : '编辑配置'}
        width={900}
        confirmLoading={savingConfig}
        okText="保存配置"
        cancelText="取消"
        onOk={handleSaveConfig}
        onCancel={() => {
          if (!savingConfig) {
            setEditingConfigApp(null);
            setConfigData(null);
            setConfigContent('');
          }
        }}
        destroyOnClose
      >
        {configLoading ? (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <Spin />
          </div>
        ) : (
          <>
            <Alert
              type="warning"
              showIcon
              icon={<LockOutlined />}
              message="配置可能包含访问令牌或其他敏感信息"
              description={configData?.requiresElevation
                ? '当前配置需要系统授权才能保存，点击保存后会显示 macOS、Linux 或 Windows 的授权提示。'
                : `格式：${configData?.configFormat || editingConfigApp?.configFormat || 'text'}；保存时会检查文件是否被其他进程修改。`}
              style={{ marginBottom: 12 }}
            />
            <Input.TextArea
              value={configContent}
              onChange={(event) => setConfigContent(event.target.value)}
              autoSize={{ minRows: 18, maxRows: 36 }}
              spellCheck={false}
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 }}
              placeholder="配置文件为空，可直接输入内容后保存"
            />
          </>
        )}
      </Modal>
    </PageScaffold>
  );
}
