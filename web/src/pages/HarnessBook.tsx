import React, { useState } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import { Button, Tooltip, Space } from 'antd';
import { BookOutlined, ExportOutlined, ReloadOutlined } from '@ant-design/icons';

const HarnessBookPage: React.FC = () => {
  const [version, setVersion] = useState<number>(() => Date.now());

  const handleOpenExternal = () => {
    window.open(`/docs/harness-book/reader/index.html?t=${version}`, '_blank');
  };

  const handleRefresh = () => {
    setVersion(Date.now());
  };

  return (
    <PageContainer
      header={{
        title: (
          <Space align="center" size="middle">
            <span style={{ fontSize: 18, fontWeight: 600 }}>
              <BookOutlined style={{ color: '#1677ff', marginRight: 8 }} />
              《现代 AI Agent 运行时与 Harness 架构设计》
            </span>
            <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 10, background: 'rgba(22,119,255,0.1)', color: '#1677ff', fontWeight: 500 }}>
              ✨ 沉浸式 AI 伴读已就绪
            </span>
          </Space>
        ),
        extra: [
          <Tooltip key="refresh" title="强制刷新阅读器缓存">
            <Button icon={<ReloadOutlined />} onClick={handleRefresh}>
              刷新重载
            </Button>
          </Tooltip>,
          <Tooltip key="external" title="新标签页独立全屏阅读">
            <Button type="primary" icon={<ExportOutlined />} onClick={handleOpenExternal}>
              独立全屏阅读
            </Button>
          </Tooltip>,
        ],
      }}
      style={{
        padding: 0,
        margin: 0,
      }}
    >
      <div
        style={{
          width: '100%',
          height: 'calc(100vh - 128px)',
          borderRadius: 8,
          overflow: 'hidden',
          border: '1px solid rgba(0,0,0,0.08)',
          background: '#0d1117',
          boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
          position: 'relative',
        }}
      >
        <iframe
          key={version}
          src={`/docs/harness-book/reader/index.html?t=${version}`}
          title="Harness Book AI Reader"
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            display: 'block',
          }}
        />
      </div>
    </PageContainer>
  );
};

export default HarnessBookPage;
