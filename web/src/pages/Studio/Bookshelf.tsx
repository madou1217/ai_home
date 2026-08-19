import React, { useState } from 'react';
import { PageContainer } from '@ant-design/pro-components';
import {
  Card,
  Row,
  Col,
  Button,
  Typography,
  Tag,
  Space,
  Progress,
  Tooltip,
  Modal,
  Badge,
  Input
} from 'antd';
import {
  BookOutlined,
  PlusOutlined,
  ReadOutlined,
  ExportOutlined,
  CheckCircleOutlined,
  ThunderboltOutlined,
  SearchOutlined,
  FireOutlined,
  CompassOutlined,
  PictureOutlined,
  CodeOutlined
} from '@ant-design/icons';
import { BookCraftDrawer } from './BookCraftDrawer';

const { Title, Text, Paragraph } = Typography;

interface BookMeta {
  id: string;
  title: string;
  subtitle: string;
  coverImage: string;
  category: string;
  tags: string[];
  totalChapters: number;
  completedChapters: number;
  readerUrl: string;
  description: string;
  badge?: string;
}

const BookshelfPage: React.FC = () => {
  const [craftDrawerVisible, setCraftDrawerVisible] = useState(false);
  const [activeReadingBook, setActiveReadingBook] = useState<BookMeta | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const books: BookMeta[] = [
    {
      id: 'harness-book',
      title: '《现代 AI Agent 运行时与 Harness 架构设计》',
      subtitle: '五大主流工业级实现源码解构与自主研发落地',
      coverImage: '/docs/harness-book/assets/images/cover-harness-book.jpg',
      category: 'Agent 运行时核心',
      tags: ['Claude Code', 'OpenAI Codex', 'OpenCode', 'DeepSeek', 'ReAct FSM', 'Dual-Parity'],
      totalChapters: 21,
      completedChapters: 21,
      readerUrl: '/docs/harness-book/reader/index.html',
      description: '全景深度解构工业界顶尖 Agent Harness 的 ReAct 状态机、工具沙箱、双轨持久化、Prompt Cache 亲和调度与双端等价通信桥。',
      badge: '👑 旗舰专著',
    },
    {
      id: 'pi-agent-book',
      title: '《Agent Pi：全双工实时流式架构与拟人情感引擎设计》',
      subtitle: '毫秒流式管道、Barge-in 即时打断、Persona 状态机与 HMG 记忆图谱',
      coverImage: '/docs/pi-agent-book/assets/images/cover-pi-agent-book.jpg',
      category: '拟人伴侣与低延迟通信',
      tags: ['Inflection Pi', 'WebSocket Wire', 'Barge-in 打断', 'VAD 情感张量', 'HMG 记忆图谱'],
      totalChapters: 12,
      completedChapters: 12,
      readerUrl: '/docs/pi-agent-book/reader/index.html',
      description: '针对传统问答 Agent 迟钝冰冷的痛点，系统性解构全双工毫秒流、语音/文字即时打断、动态情感共鸣与艾宾浩斯记忆衰减模型。',
      badge: '✨ 全新上线',
    }
  ];

  const filteredBooks = books.filter(b => 
    b.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    b.tags.some(t => t.toLowerCase().includes(searchQuery.toLowerCase())) ||
    b.description.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleOpenReader = (book: BookMeta) => {
    setActiveReadingBook(book);
  };

  const handleOpenExternal = (url: string) => {
    window.open(`${url}?t=${Date.now()}`, '_blank');
  };

  return (
    <PageContainer
      header={{
        title: (
          <Space align="center" size="middle">
            <BookOutlined style={{ color: '#1677ff', fontSize: 24 }} />
            <span style={{ fontSize: 20, fontWeight: 600 }}>
              AI 知识书架与创作工坊 (Library & Book-Craft)
            </span>
            <Tag color="blue">2 本技术专著</Tag>
            <Tag color="green">免密 AI 伴读已就绪</Tag>
          </Space>
        ),
        subTitle: '汇聚生产级 AI Agent 架构体系专著，支持沉浸式伴读、8K AI 封面概念生成与一键出书',
        extra: [
          <Input
            key="search"
            placeholder="搜索书名、技术标签或架构机制..."
            prefix={<SearchOutlined style={{ color: '#8c8c8c' }} />}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{ width: 260, borderRadius: 6 }}
            allowClear
          />,
          <Button
            key="add-book"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCraftDrawerVisible(true)}
            style={{
              background: 'linear-gradient(135deg, #1677ff 0%, #722ed1 100%)',
              border: 'none',
              fontWeight: 500,
              boxShadow: '0 2px 8px rgba(22, 119, 255, 0.3)',
            }}
          >
            ✨ 新增书籍 (book-craft)
          </Button>,
        ],
      }}
    >
      {/* 顶部横幅引导 */}
      <Card
        bordered={false}
        style={{
          marginBottom: 24,
          borderRadius: 12,
          background: 'linear-gradient(135deg, rgba(22,119,255,0.06) 0%, rgba(114,46,209,0.06) 100%)',
          border: '1px solid rgba(22,119,255,0.12)',
        }}
      >
        <Row align="middle" justify="space-between" gutter={[16, 16]}>
          <Col xs={24} md={16}>
            <Title level={4} style={{ margin: 0, color: '#1f1f1f' }}>
              💡 现代 Agent 运行时技术专著系列
            </Title>
            <Paragraph style={{ margin: '8px 0 0 0', color: '#595959', fontSize: 13 }}>
              所有专著均包含 8K AI 概念插画、双语矢量流程图与动态交互仿真器。读者可在阅读过程中鼠标划词直接唤起本地 aih-server 进行免密深度解析。
            </Paragraph>
          </Col>
          <Col xs={24} md={8} style={{ textAlign: 'right' }}>
            <Space>
              <Button icon={<CompassOutlined />} onClick={() => setCraftDrawerVisible(true)}>
                出书工作流规范
              </Button>
              <Button type="primary" ghost icon={<ThunderboltOutlined />} onClick={() => setCraftDrawerVisible(true)}>
                逆向 GitHub 出书
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {/* 书籍卡片网格 */}
      <Row gutter={[24, 24]}>
        {filteredBooks.map((book) => {
          const progressPercent = Math.round((book.completedChapters / book.totalChapters) * 100);
          return (
            <Col xs={24} sm={24} md={12} lg={12} xl={8} key={book.id}>
              <Badge.Ribbon text={book.badge || 'PROD'} color={book.id === 'harness-book' ? 'blue' : 'purple'}>
                <Card
                  hoverable
                  bordered={false}
                  style={{
                    borderRadius: 12,
                    overflow: 'hidden',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.06)',
                    display: 'flex',
                    flexDirection: 'column',
                    height: '100%',
                    transition: 'all 0.3s ease',
                  }}
                  bodyStyle={{ padding: 20, flex: 1, display: 'flex', flexDirection: 'column' }}
                >
                  {/* 书籍封面容器 */}
                  <div
                    style={{
                      height: 220,
                      borderRadius: 8,
                      overflow: 'hidden',
                      position: 'relative',
                      background: '#0d1117',
                      marginBottom: 16,
                      boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                    }}
                  >
                    <img
                      src={book.coverImage}
                      alt={book.title}
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        transition: 'transform 0.4s ease',
                      }}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        background: 'linear-gradient(to top, rgba(13,17,23,0.95) 0%, transparent 100%)',
                        padding: '24px 12px 8px 12px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-end',
                      }}
                    >
                      <Tag color="cyan" style={{ border: 'none', background: 'rgba(19, 194, 194, 0.2)', color: '#13c2c2', fontWeight: 500 }}>
                        {book.category}
                      </Tag>
                      <span style={{ color: '#fff', fontSize: 12, opacity: 0.9 }}>
                        {book.completedChapters} / {book.totalChapters} 章节全量完工
                      </span>
                    </div>
                  </div>

                  {/* 书籍标题与简介 */}
                  <Title level={5} style={{ margin: '0 0 4px 0', fontSize: 16, fontWeight: 600, color: '#1f1f1f' }}>
                    {book.title}
                  </Title>
                  <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: 'block' }}>
                    {book.subtitle}
                  </Text>

                  <Paragraph
                    ellipsis={{ rows: 2, tooltip: book.description }}
                    style={{ color: '#595959', fontSize: 13, flex: 1, marginBottom: 12 }}
                  >
                    {book.description}
                  </Paragraph>

                  {/* 标签 */}
                  <div style={{ marginBottom: 16 }}>
                    {book.tags.map((tag) => (
                      <Tag key={tag} style={{ margin: '0 4px 4px 0', fontSize: 11 }}>
                        {tag}
                      </Tag>
                    ))}
                  </div>

                  {/* 进度条 */}
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                      <Text type="secondary">编写与验收进度</Text>
                      <Text strong style={{ color: '#52c41a' }}>100% (已验收)</Text>
                    </div>
                    <Progress percent={progressPercent} status="success" strokeColor="#52c41a" size="small" />
                  </div>

                  {/* 操作按钮组 */}
                  <div style={{ display: 'flex', gap: 10, marginTop: 'auto' }}>
                    <Button
                      type="primary"
                      icon={<ReadOutlined />}
                      onClick={() => handleOpenReader(book)}
                      style={{ flex: 1, borderRadius: 6, fontWeight: 500 }}
                    >
                      内嵌沉浸阅读
                    </Button>
                    <Tooltip title="新窗口独立全屏打开">
                      <Button
                        icon={<ExportOutlined />}
                        onClick={() => handleOpenExternal(book.readerUrl)}
                        style={{ borderRadius: 6 }}
                      />
                    </Tooltip>
                  </div>
                </Card>
              </Badge.Ribbon>
            </Col>
          );
        })}
      </Row>

      {/* 内嵌阅读器 Modal */}
      {activeReadingBook && (
        <Modal
          title={
            <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
              <Space>
                <BookOutlined style={{ color: '#1677ff' }} />
                <span style={{ fontWeight: 600 }}>{activeReadingBook.title}</span>
                <Tag color="green">AI 伴读 Copilot 免密连通</Tag>
              </Space>
              <Button
                type="link"
                icon={<ExportOutlined />}
                onClick={() => handleOpenExternal(activeReadingBook.readerUrl)}
                style={{ paddingRight: 24 }}
              >
                新标签页独立全屏
              </Button>
            </Space>
          }
          open={!!activeReadingBook}
          onCancel={() => setActiveReadingBook(null)}
          footer={null}
          width="94vw"
          style={{ top: 20 }}
          bodyStyle={{ height: '82vh', padding: 0 }}
        >
          <iframe
            src={`${activeReadingBook.readerUrl}?t=${Date.now()}`}
            title={activeReadingBook.title}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              display: 'block',
              background: '#0d1117',
            }}
          />
        </Modal>
      )}

      {/* 新增书籍与出书 Drawer */}
      <BookCraftDrawer
        visible={craftDrawerVisible}
        onClose={() => setCraftDrawerVisible(false)}
      />
    </PageContainer>
  );
};

export default BookshelfPage;
