import React, { useState, useEffect } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import { Button, Tooltip, Space } from 'antd';
import { BookOutlined, RobotOutlined, FullscreenOutlined, ExportOutlined, ReloadOutlined } from '@ant-design/icons';

const HarnessBookPage: React.FC = () => {
  const [iframeSrc, setIframeSrc] = useState<string>('/docs/harness-book/reader/index.html');
  const [iframeKey, setIframeKey] = useState<number>(1);

  const handleOpenExternal = () => {
    window.open('/docs/harness-book/reader/index.html', '_blank');
  };

  const handleRefresh = () => {
    setIframeKey((prev) => prev + 1);
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
              ✨ AI 伴读已接入
            </span>
          </Space>
        ),
        extra: [
          <Tooltip key="refresh" title="刷新阅读器">
            <Button icon={<ReloadOutlined />} onClick={handleRefresh}>
              刷新
            </Button>
          </Tooltip>,
          <Tooltip key="external" title="新标签页沉浸全屏阅读">
            <Button type="primary" icon={<ExportOutlined />} onClick={handleOpenExternal}>
              新窗口全屏阅读
            </Button>
          </Tooltip>,
        ],
      }}
      style={{
        paddingBottom: 0,
      }}
    >
      <div
        style={{
          width: '100%',
          height: 'calc(100vh - 160px)',
          borderRadius: 8,
          overflow: 'hidden',
          border: '1px solid var(--ant-color-border-secondary, #30363d)',
          background: '#0d1117',
          boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
        }}
      >
        <iframe
          key={iframeKey}
          src={iframeSrc}
          title="Harness Book AI Reader"
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
          }}
        />
      </div>
    </PageContainer>
  );
};

export default HarnessBookPage;
