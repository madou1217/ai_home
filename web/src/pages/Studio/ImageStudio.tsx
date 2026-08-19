import React, { useState } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import {
  Card,
  Input,
  Button,
  Row,
  Col,
  Typography,
  Space,
  Select,
  Tag,
  message,
  Spin,
  Empty,
  Image,
  Divider,
  Tooltip
} from 'antd';
import {
  PictureOutlined,
  ThunderboltOutlined,
  DownloadOutlined,
  CopyOutlined,
  ClearOutlined,
  AppstoreOutlined,
  FireOutlined
} from '@ant-design/icons';

const { TextArea } = Input;
const { Text, Title, Paragraph } = Typography;

interface GeneratedHistoryItem {
  id: string;
  prompt: string;
  model: string;
  imageUrl: string;
  createdAt: number;
}

const ImageStudioPage: React.FC = () => {
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('gemini-3.1-flash-image');
  const [loading, setLoading] = useState(false);
  const [currentImage, setCurrentImage] = useState<string | null>(null);
  const [history, setHistory] = useState<GeneratedHistoryItem[]>(() => {
    // 预设几张书籍生成的精彩封面/插图
    return [
      {
        id: 'harness-cover',
        prompt: "Modern AI Agent Runtime & Harness Architecture Design, cyberpunk holographic state machine, 8K concept art",
        model: 'gemini-3.1-flash-image',
        imageUrl: '/docs/harness-book/assets/images/cover-harness-book.jpg',
        createdAt: Date.now() - 3600000,
      },
      {
        id: 'pi-cover',
        prompt: "Agent Pi: Full-Duplex Real-Time Streaming Agent Architecture & Emotional Persona Engine, 8k resolution",
        model: 'gemini-3.1-flash-image',
        imageUrl: '/docs/pi-agent-book/assets/images/cover-pi-agent-book.jpg',
        createdAt: Date.now() - 1800000,
      }
    ];
  });

  const promptPresets = [
    {
      label: '📖 电子书极客封面 (Cyberpunk Book Cover)',
      value: 'An ultra-modern 8K futuristic cyberpunk book cover for a technical architecture book. Features glowing holographic state machine nodes, neural circuit pathways, dark titanium and electric blue neon palette, cinematic lighting, photorealistic concept art.',
    },
    {
      label: '⚡ 全双工流式架构 (Streaming Pipeline)',
      value: 'A high-tech 8K digital visualization of a full-duplex streaming pipeline and microsecond token demuxing. Ultra-low latency data packets flowing across glowing fiber optic tracks, deep navy blue and emerald green hues, 8k render.',
    },
    {
      label: '🧠 记忆图谱与神经元 (Memory Graph)',
      value: 'A magnificent 8K holographic architecture diagram of Three-Tier Cognitive Memory: Core Profile at the summit, Semantic Graph in the center, crystal nodes, glowing neural axons, dark theme with gold and cyan lighting.',
    },
    {
      label: '🎭 拟人情感状态机 (Persona FSM)',
      value: 'An 8K intricate holographic Finite State Machine (FSM) diagram of AI persona emotions. Glowing nodes transitioning with dynamic chromatic aura, futuristic interface, 8k concept art.',
    }
  ];

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      message.warning('请输入生图提示词（Prompt）');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/docs/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt.trim() }]
        })
      });

      if (!res.ok) {
        throw new Error(`生成请求失败 (HTTP ${res.status})`);
      }

      const json = await res.json();
      const content = json.choices?.[0]?.message?.content || '';
      const match = content.match(/data:image\/[a-zA-Z]+;base64,([^\)]+)/);

      if (match) {
        const fullBase64 = `data:image/jpeg;base64,${match[1]}`;
        setCurrentImage(fullBase64);
        const newItem: GeneratedHistoryItem = {
          id: String(Date.now()),
          prompt: prompt.trim(),
          model,
          imageUrl: fullBase64,
          createdAt: Date.now(),
        };
        setHistory(prev => [newItem, ...prev]);
        message.success('AI 图像生成成功！');
      } else {
        message.error('未在模型响应中解析到图像数据');
      }
    } catch (e: any) {
      console.error(e);
      message.error(`生成异常: ${e.message || '网络连接超时'}`);
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = (dataUrl: string, filename = 'generated-artwork.jpg') => {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    a.click();
  };

  return (
    <PageContainer
      header={{
        title: (
          <Space align="center">
            <PictureOutlined style={{ color: '#722ed1', fontSize: 22 }} />
            <span style={{ fontSize: 20, fontWeight: 600 }}>AI 生图与多模态创作工坊</span>
            <Tag color="purple">直连 本地 aih-server</Tag>
          </Space>
        ),
        subTitle: '调用本地 gemini-3.1-flash-image 极速生成 8K 概念艺术图、电子书插画与架构可视化图',
      }}
    >
      <Row gutter={[20, 20]}>
        {/* 左侧：输入与控制面板 */}
        <Col xs={24} lg={10}>
          <Card
            title={
              <Space>
                <ThunderboltOutlined style={{ color: '#1677ff' }} />
                <span>创作控制台 (Prompt & Settings)</span>
              </Space>
            }
            bordered={false}
            style={{ borderRadius: 10, boxShadow: '0 2px 10px rgba(0,0,0,0.04)' }}
          >
            <div style={{ marginBottom: 16 }}>
              <Text strong style={{ display: 'block', marginBottom: 6 }}>
                生成模型 (Vision/Image Model)：
              </Text>
              <Select
                value={model}
                onChange={setModel}
                style={{ width: '100%' }}
                options={[
                  { label: '✨ gemini-3.1-flash-image (8K 概念图/插画首选)', value: 'gemini-3.1-flash-image' },
                  { label: '🎨 gemini-2.5-flash-image', value: 'gemini-2.5-flash-image' },
                ]}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <Space style={{ marginBottom: 6, width: '100%', justifyContent: 'space-between' }}>
                <Text strong>提示词预设模板：</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>点击快速填入</Text>
              </Space>
              <Select
                placeholder="选择常用预设灵感模板..."
                style={{ width: '100%' }}
                onChange={(val) => setPrompt(val)}
                options={promptPresets}
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              <Text strong style={{ display: 'block', marginBottom: 6 }}>
                画面细节描述 (Prompt)：
              </Text>
              <TextArea
                rows={6}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="描述你想要的画面，例如：An epic 8K cyberpunk concept art of modern AI agent runtime, glowing fiber optics, blue neon aura, 8k resolution..."
                style={{ borderRadius: 8 }}
              />
            </div>

            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
              <Button icon={<ClearOutlined />} onClick={() => setPrompt('')}>
                清空
              </Button>
              <Button
                type="primary"
                size="large"
                icon={<ThunderboltOutlined />}
                onClick={handleGenerate}
                loading={loading}
                style={{
                  background: 'linear-gradient(135deg, #722ed1 0%, #1677ff 100%)',
                  border: 'none',
                  paddingLeft: 24,
                  paddingRight: 24,
                }}
              >
                立即生成 8K 画作
              </Button>
            </Space>
          </Card>
        </Col>

        {/* 右侧：生成结果与画布 */}
        <Col xs={24} lg={14}>
          <Card
            title={
              <Space>
                <PictureOutlined style={{ color: '#52c41a' }} />
                <span>实时渲染视口 (Artboard Viewport)</span>
              </Space>
            }
            bordered={false}
            style={{ borderRadius: 10, minHeight: 460, boxShadow: '0 2px 10px rgba(0,0,0,0.04)' }}
            extra={
              currentImage && (
                <Button
                  icon={<DownloadOutlined />}
                  size="small"
                  type="primary"
                  onClick={() => handleDownload(currentImage)}
                >
                  保存高清原图
                </Button>
              )
            }
          >
            {loading ? (
              <div style={{ textAlign: 'center', padding: '80px 0' }}>
                <Spin size="large" />
                <div style={{ marginTop: 20, color: '#8c8c8c', fontSize: 14 }}>
                  🎨 AI 正在调用 gemini-3.1-flash-image 渲染 8K 画作中，请稍候...
                </div>
              </div>
            ) : currentImage ? (
              <div style={{ textAlign: 'center' }}>
                <div
                  style={{
                    borderRadius: 8,
                    overflow: 'hidden',
                    background: '#0d1117',
                    padding: 8,
                    display: 'inline-block',
                    boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                    maxWidth: '100%',
                  }}
                >
                  <Image
                    src={currentImage}
                    alt="AI Artwork"
                    style={{ maxHeight: 380, objectFit: 'contain', borderRadius: 6 }}
                  />
                </div>
                <div style={{ marginTop: 16 }}>
                  <Text type="secondary" style={{ fontSize: 13 }}>
                    提示词：{prompt}
                  </Text>
                </div>
              </div>
            ) : (
              <Empty
                description="暂无当前渲染图像，请在左侧输入提示词后点击生成"
                style={{ padding: '80px 0' }}
              />
            )}
          </Card>
        </Col>
      </Row>

      {/* 下方：历史生成画廊 */}
      <Divider orientation="left" style={{ marginTop: 30 }}>
        <Space>
          <AppstoreOutlined />
          <span>工坊画廊与灵感资产库 ({history.length})</span>
        </Space>
      </Divider>

      <Row gutter={[16, 16]}>
        {history.map((item) => (
          <Col xs={24} sm={12} md={8} lg={6} key={item.id}>
            <Card
              hoverable
              cover={
                <div style={{ height: 180, overflow: 'hidden', background: '#0d1117', position: 'relative' }}>
                  <img
                    src={item.imageUrl}
                    alt="Artwork"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                </div>
              }
              actions={[
                <Tooltip title="使用此提示词">
                  <CopyOutlined key="copy" onClick={() => setPrompt(item.prompt)} />
                </Tooltip>,
                <Tooltip title="下载图像">
                  <DownloadOutlined key="download" onClick={() => handleDownload(item.imageUrl)} />
                </Tooltip>,
              ]}
              style={{ borderRadius: 8 }}
            >
              <Card.Meta
                title={<Tag color="blue">{item.model}</Tag>}
                description={
                  <Paragraph
                    ellipsis={{ rows: 2, tooltip: item.prompt }}
                    style={{ fontSize: 12, color: '#595959', margin: 0 }}
                  >
                    {item.prompt}
                  </Paragraph>
                }
              />
            </Card>
          </Col>
        ))}
      </Row>
    </PageContainer>
  );
};

export default ImageStudioPage;
