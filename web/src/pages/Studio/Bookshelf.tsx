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
  Input,
  Radio,
  Tabs
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
  CodeOutlined,
  AppstoreOutlined,
  RobotOutlined,
  SendOutlined,
  ControlOutlined
} from '@ant-design/icons';
import { BookCraftDrawer } from './BookCraftDrawer';

const { Title, Text, Paragraph } = Typography;

interface BookMeta {
  id: string;
  title: string;
  subtitle: string;
  coverImage: string;
  mainCategory: 'all' | 'harness' | 'embodied' | 'pi-series';
  subCategory: string;
  tags: string[];
  totalChapters: number;
  completedChapters: number;
  readerUrl: string;
  description: string;
  badge?: string;
  styleTheme: string;
}

const BookshelfPage: React.FC = () => {
  const [craftDrawerVisible, setCraftDrawerVisible] = useState(false);
  const [activeReadingBook, setActiveReadingBook] = useState<BookMeta | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  const books: BookMeta[] = [
    {
      id: 'harness-book',
      title: '《现代 AI Agent 运行时与 Harness 架构设计》',
      subtitle: '五大主流工业级实现源码解构与自主研发落地',
      coverImage: '/docs/harness-book/assets/images/cover-harness-book.jpg',
      mainCategory: 'harness',
      subCategory: 'AI ➔ Harness 架构内核',
      tags: ['Claude Code', 'OpenAI Codex', 'OpenCode', 'DeepSeek', 'ReAct FSM', 'Dual-Parity'],
      totalChapters: 21,
      completedChapters: 21,
      readerUrl: '/docs/harness-book/reader/index.html',
      description: '全景深度解构工业界顶尖 Agent Harness 的 ReAct 状态机、工具沙箱、双轨持久化、Prompt Cache 亲和调度与双端等价通信桥。',
      badge: '👑 旗舰总纲',
      styleTheme: '深空极客极简风 (Linear Dark)'
    },
    {
      id: 'pi-agent-book',
      title: '《Physical Intelligence π0 与通用具身 Agent 架构设计》',
      subtitle: 'VLA 视觉-语言-动作大模型、Flow Matching 连续流与 50Hz 实时控制',
      coverImage: '/docs/pi-agent-book/assets/images/cover-pi-agent-book.jpg',
      mainCategory: 'embodied',
      subCategory: 'AI ➔ 具身物理智能 ➔ π0',
      tags: ['Physical Intelligence', 'π0 VLA', 'Flow Matching', 'Cross-Embodiment', '50Hz Control'],
      totalChapters: 12,
      completedChapters: 12,
      readerUrl: '/docs/pi-agent-book/reader/index.html',
      description: '解构通用物理机器人大模型 π0，涵盖连续动作流匹配、跨本体（双臂/移动底盘）泛化与硬件阻抗力控闭环。',
      badge: '🤖 具身智能',
      styleTheme: '硬核机甲未来风 (Mecha Cyber)'
    },
    {
      id: 'pi-core-book',
      title: '《Pi 编码 Agent 架构与终端 TUI 引擎设计》',
      subtitle: '从 @earendil-works/pi 源码解构多模型统一层、差异化 TUI 渲染与微虚拟机沙箱',
      coverImage: '/docs/pi-core-book/assets/images/cover-pi-core-book.jpg',
      mainCategory: 'pi-series',
      subCategory: 'AI ➔ Coding Agent ➔ Pi 内核篇',
      tags: ['earendil-works/pi', 'pi-tui 差量渲染', 'pi-ai 统一层', 'Gondolin Micro-VM', '/loop 状态机'],
      totalChapters: 11,
      completedChapters: 11,
      readerUrl: '/docs/pi-core-book/reader/index.html',
      description: '1000% 深度钻透开源自扩展编程助手 Pi 的 Monorepo 五大核心包、终端 0 闪烁差量屏幕更新算法与微虚拟机物理沙箱。',
      badge: '⚡ 源码内核篇',
      styleTheme: '终端黑客极客风 (TUI Hacker)'
    },
    {
      id: 'pi-practice-book',
      title: '《现代 Coding Agent 高阶实战与生产级调优指南》',
      subtitle: '从 0 到 100 打造个人全自动编程副驾、Token 成本控制与复杂工程重构工作流',
      coverImage: '/docs/pi-practice-book/assets/images/cover-pi-practice-book.jpg',
      mainCategory: 'pi-series',
      subCategory: 'AI ➔ Coding Agent ➔ Pi 实战篇',
      tags: ['长程重构', '80% 上下文剪枝', 'Token 降本 80%', 'AST 精确切片', '5大异常自愈'],
      totalChapters: 8,
      completedChapters: 8,
      readerUrl: '/docs/pi-practice-book/reader/index.html',
      description: '面向一线开发者的生产级实战手册：长程会话上下文治理、多文件 AST 重构、自定义 Slash Commands 插件与死循环自愈技巧。',
      badge: '🛠️ 进阶实战篇',
      styleTheme: '现代工程极简风 (Linear Clean)'
    },
    {
      id: 'pi-telegram-book',
      title: '《Pi-Telegram 远程自主开发与全自动调度系统设计》',
      subtitle: '基于 Telegram 打造随时随地的 7×24 小时无人值守 AI 研发协作中心',
      coverImage: '/docs/pi-telegram-book/assets/images/cover-pi-telegram-book.jpg',
      mainCategory: 'pi-series',
      subCategory: 'AI ➔ Coding Agent ➔ Pi 远程生态篇',
      tags: ['Ziphyrien/Pi-Telegram', 'AI Tag 协议桥', 'Croner 10 引擎', '多租户隔离', '7x24 无人巡检'],
      totalChapters: 7,
      completedChapters: 7,
      readerUrl: '/docs/pi-telegram-book/reader/index.html',
      description: '解构如何将终端 Agent 桥接至 Telegram：AI Tag 流式拦截（tg-reply/cron）、分布式定时任务引擎与多租户会话物理隔离。',
      badge: '📡 远程生态篇',
      styleTheme: '分布式协作风 (Telegram Cyber)'
    }
  ];

  const filteredBooks = books.filter(b => {
    const matchesCategory = selectedCategory === 'all' || b.mainCategory === selectedCategory;
    const matchesSearch = 
      b.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      b.tags.some(t => t.toLowerCase().includes(searchQuery.toLowerCase())) ||
      b.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      b.subCategory.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

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
            <Tag color="blue">5 部大师级专著已上架</Tag>
            <Tag color="green">免密 AI 伴读已就绪</Tag>
          </Space>
        ),
        subTitle: '包含 AI Harness 运行时架构、Physical Intelligence 具身大模型、以及 Pi 自扩展 Coding Agent 全套源码剖析与实战专著',
        extra: [
          <Input
            key="search"
            placeholder="搜索书名、子分类或技术标签..."
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
      {/* 分类导航 Tabs */}
      <Card
        bordered={false}
        bodyStyle={{ padding: '12px 20px' }}
        style={{ marginBottom: 20, borderRadius: 10, boxShadow: '0 2px 8px rgba(0,0,0,0.03)' }}
      >
        <Row align="middle" justify="space-between" gutter={[16, 16]}>
          <Col xs={24} md={18}>
            <Radio.Group
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              buttonStyle="solid"
            >
              <Radio.Button value="all">
                <AppstoreOutlined style={{ marginRight: 6 }} />
                全部专著 (5)
              </Radio.Button>
              <Radio.Button value="harness">
                <ControlOutlined style={{ marginRight: 6 }} />
                AI ➔ Harness 运行时 (1)
              </Radio.Button>
              <Radio.Button value="embodied">
                <RobotOutlined style={{ marginRight: 6 }} />
                AI ➔ 具身物理智能 (π0) (1)
              </Radio.Button>
              <Radio.Button value="pi-series">
                <CodeOutlined style={{ marginRight: 6 }} />
                AI ➔ Coding Agent ➔ Pi 开源三部曲 (3)
              </Radio.Button>
            </Radio.Group>
          </Col>
          <Col xs={24} md={6} style={{ textAlign: 'right' }}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              支持按领域自适应 AI 渲染排版模板
            </Text>
          </Col>
        </Row>
      </Card>

      {/* 书籍卡片网格 */}
      <Row gutter={[24, 24]}>
        {filteredBooks.map((book) => {
          const progressPercent = Math.round((book.completedChapters / book.totalChapters) * 100);
          return (
            <Col xs={24} sm={24} md={12} lg={12} xl={8} key={book.id}>
              <Badge.Ribbon
                text={book.badge || 'PROD'}
                color={
                  book.mainCategory === 'harness' ? 'blue' :
                  book.mainCategory === 'embodied' ? 'gold' :
                  book.id === 'pi-core-book' ? 'green' :
                  book.id === 'pi-practice-book' ? 'purple' : 'cyan'
                }
              >
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
                      <Tag color="blue" style={{ border: 'none', background: 'rgba(22, 119, 255, 0.25)', color: '#58a6ff', fontWeight: 500 }}>
                        {book.subCategory}
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

                  {/* 风格与标签 */}
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ marginBottom: 6 }}>
                      <Tag color="geekblue" style={{ fontSize: 11 }}>
                        🎨 风格模板: {book.styleTheme}
                      </Tag>
                    </div>
                    <div>
                      {book.tags.map((tag) => (
                        <Tag key={tag} style={{ margin: '0 4px 4px 0', fontSize: 11 }}>
                          {tag}
                        </Tag>
                      ))}
                    </div>
                  </div>

                  {/* 进度条 */}
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                      <Text type="secondary">编写与验收状态</Text>
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
