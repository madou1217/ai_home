import React, { useState, useMemo } from 'react';
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
  TreeSelect,
  Breadcrumb,
  Empty,
  Statistic
} from 'antd';
import {
  BookOutlined,
  PlusOutlined,
  ReadOutlined,
  ExportOutlined,
  SearchOutlined,
  AppstoreOutlined,
  RobotOutlined,
  CodeOutlined,
  ControlOutlined,
  CheckCircleOutlined,
  LoadingOutlined,
  FolderOpenOutlined
} from '@ant-design/icons';
import { BookCraftDrawer } from './BookCraftDrawer';

const { Title, Text, Paragraph } = Typography;

export interface CategoryNode {
  title: string;
  value: string;
  key: string;
  icon?: React.ReactNode;
  children?: CategoryNode[];
}

export interface BookMeta {
  id: string;
  title: string;
  subtitle: string;
  coverImage: string;
  categoryPath: string[]; // e.g. ['ai', 'agent-runtime', 'harness-core']
  categoryLabels: string[]; // e.g. ['人工智能 (AI)', 'AI Agent 运行时', 'Harness 核心架构']
  tags: string[];
  totalChapters: number;
  completedChapters: number;
  readerUrl: string;
  description: string;
  badge?: string;
  styleTheme: string;
  status: 'completed' | 'generating' | 'queued';
}

const CATEGORY_TREE: CategoryNode[] = [
  {
    title: '全部专著 (All Books)',
    value: 'all',
    key: 'all',
    children: [
      {
        title: '🤖 人工智能 (AI)',
        value: 'ai',
        key: 'ai',
        children: [
          {
            title: '⚙️ AI Agent 运行时 (Runtime & Harness)',
            value: 'ai/agent-runtime',
            key: 'ai/agent-runtime',
            children: [
              {
                title: '📘 Harness 架构核心',
                value: 'ai/agent-runtime/harness-core',
                key: 'ai/agent-runtime/harness-core',
              }
            ]
          },
          {
            title: '🦾 具身物理智能 (Embodied AI)',
            value: 'ai/embodied',
            key: 'ai/embodied',
            children: [
              {
                title: '🤖 Physical Intelligence π0',
                value: 'ai/embodied/pi-zero',
                key: 'ai/embodied/pi-zero',
              }
            ]
          },
          {
            title: '💻 编码 Agent 体系 (Coding Agent)',
            value: 'ai/coding-agent',
            key: 'ai/coding-agent',
            children: [
              {
                title: '⚡ Pi 架构与 TUI 内核',
                value: 'ai/coding-agent/pi-core',
                key: 'ai/coding-agent/pi-core',
              },
              {
                title: '🛠️ 现代 Coding 实战调优',
                value: 'ai/coding-agent/pi-practice',
                key: 'ai/coding-agent/pi-practice',
              },
              {
                title: '📡 Pi-Telegram 远程自动化',
                value: 'ai/coding-agent/pi-telegram',
                key: 'ai/coding-agent/pi-telegram',
              }
            ]
          }
        ]
      }
    ]
  }
];

const ALL_BOOKS: BookMeta[] = [
  {
    id: 'harness-book',
    title: '《现代 AI Agent 运行时与 Harness 架构设计》',
    subtitle: '五大主流工业级实现源码解构与自主研发落地',
    coverImage: '/docs/harness-book/assets/images/cover-harness-book.jpg',
    categoryPath: ['ai', 'ai/agent-runtime', 'ai/agent-runtime/harness-core'],
    categoryLabels: ['人工智能 (AI)', 'AI Agent 运行时', 'Harness 架构核心'],
    tags: ['Claude Code', 'OpenAI Codex', 'OpenCode', 'DeepSeek', 'ReAct FSM', 'Dual-Parity'],
    totalChapters: 21,
    completedChapters: 21,
    readerUrl: '/docs/harness-book/reader/index.html',
    description: '全景深度解构工业界顶尖 Agent Harness 的 ReAct 状态机、工具沙箱、双轨持久化、Prompt Cache 亲和调度与双端等价通信桥。',
    badge: '👑 旗舰总纲',
    styleTheme: '深空极客极简风 (Linear Dark)',
    status: 'completed'
  },
  {
    id: 'pi-agent-book',
    title: '《Physical Intelligence π0 与通用具身 Agent 架构设计》',
    subtitle: 'VLA 视觉-语言-动作大模型、Flow Matching 连续流与 50Hz 实时控制',
    coverImage: '/docs/pi-agent-book/assets/images/cover-pi-agent-book.jpg',
    categoryPath: ['ai', 'ai/embodied', 'ai/embodied/pi-zero'],
    categoryLabels: ['人工智能 (AI)', '具身物理智能', 'Physical Intelligence π0'],
    tags: ['Physical Intelligence', 'π0 VLA', 'Flow Matching', 'Cross-Embodiment', '50Hz Control'],
    totalChapters: 12,
    completedChapters: 12,
    readerUrl: '/docs/pi-agent-book/reader/index.html',
    description: '解构通用物理机器人大模型 π0，涵盖连续动作流匹配、跨本体（双臂/移动底盘）泛化与硬件阻抗力控闭环。',
    badge: '🤖 具身智能',
    styleTheme: '硬核机甲未来风 (Mecha Cyber)',
    status: 'completed'
  },
  {
    id: 'pi-core-book',
    title: '《Pi 编码 Agent 架构与终端 TUI 引擎设计》',
    subtitle: '从 @earendil-works/pi 源码解构多模型统一层、差异化 TUI 渲染与微虚拟机沙箱',
    coverImage: '/docs/pi-core-book/assets/images/cover-pi-core-book.jpg',
    categoryPath: ['ai', 'ai/coding-agent', 'ai/coding-agent/pi-core'],
    categoryLabels: ['人工智能 (AI)', '编码 Agent 体系', 'Pi 架构与 TUI 内核'],
    tags: ['earendil-works/pi', 'pi-tui 差量渲染', 'pi-ai 统一层', 'Gondolin Micro-VM', '/loop 状态机'],
    totalChapters: 11,
    completedChapters: 11,
    readerUrl: '/docs/pi-core-book/reader/index.html',
    description: '1000% 深度钻透开源自扩展编程助手 Pi 的 Monorepo 五大核心包、终端 0 闪烁差量屏幕更新算法与微虚拟机物理沙箱。',
    badge: '⚡ 源码内核篇',
    styleTheme: '终端黑客极客风 (TUI Hacker)',
    status: 'completed'
  },
  {
    id: 'pi-practice-book',
    title: '《现代 Coding Agent 高阶实战与生产级调优指南》',
    subtitle: '从 0 到 1 打造个人全自动编程副驾、Token 成本控制与复杂工程重构工作流',
    coverImage: '/docs/pi-practice-book/assets/images/cover-pi-practice-book.jpg',
    categoryPath: ['ai', 'ai/coding-agent', 'ai/coding-agent/pi-practice'],
    categoryLabels: ['人工智能 (AI)', '编码 Agent 体系', '现代 Coding 实战调优'],
    tags: ['长程重构', '80% 上下文剪枝', 'Token 降本 80%', 'AST 精确切片', '5大异常自愈'],
    totalChapters: 8,
    completedChapters: 8,
    readerUrl: '/docs/pi-practice-book/reader/index.html',
    description: '面向一线开发者的生产级实战手册：长程会话上下文治理、多文件 AST 重构、自定义 Slash Commands 插件与死循环自愈技巧。',
    badge: '🛠️ 进阶实战篇',
    styleTheme: '现代工程极简风 (Linear Clean)',
    status: 'completed'
  },
  {
    id: 'pi-telegram-book',
    title: '《Pi-Telegram 远程自主开发与全自动调度系统设计》',
    subtitle: '基于 Telegram 打造随时随地的 7×24 小时无人值守 AI 研发协作中心',
    coverImage: '/docs/pi-telegram-book/assets/images/cover-pi-telegram-book.jpg',
    categoryPath: ['ai', 'ai/coding-agent', 'ai/coding-agent/pi-telegram'],
    categoryLabels: ['人工智能 (AI)', '编码 Agent 体系', 'Pi-Telegram 远程自动化'],
    tags: ['Ziphyrien/Pi-Telegram', 'AI Tag 协议桥', 'Croner 10 引擎', '多租户隔离', '7x24 无人巡检'],
    totalChapters: 7,
    completedChapters: 7,
    readerUrl: '/docs/pi-telegram-book/reader/index.html',
    description: '解构如何将终端 Agent 桥接至 Telegram：AI Tag 流式拦截（tg-reply/cron）、分布式定时任务引擎与多租户会话物理隔离。',
    badge: '📡 远程生态篇',
    styleTheme: '分布式协作风 (Telegram Cyber)',
    status: 'completed'
  }
];

const BookshelfPage: React.FC = () => {
  const [craftDrawerVisible, setCraftDrawerVisible] = useState(false);
  const [activeReadingBook, setActiveReadingBook] = useState<BookMeta | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategoryKey, setSelectedCategoryKey] = useState<string>('all');

  // 多级联动过滤计算
  const filteredBooks = useMemo(() => {
    return ALL_BOOKS.filter((book) => {
      // 分类树路径匹配
      const matchesCategory =
        selectedCategoryKey === 'all' ||
        book.categoryPath.includes(selectedCategoryKey) ||
        book.categoryPath.some((p) => p.startsWith(selectedCategoryKey));

      // 文本搜索匹配
      const matchesSearch =
        !searchQuery.trim() ||
        book.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        book.subtitle.toLowerCase().includes(searchQuery.toLowerCase()) ||
        book.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        book.categoryLabels.some((l) => l.toLowerCase().includes(searchQuery.toLowerCase())) ||
        book.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()));

      return matchesCategory && matchesSearch;
    });
  }, [selectedCategoryKey, searchQuery]);

  // 当前分类的面包屑导航
  const breadcrumbs = useMemo(() => {
    if (selectedCategoryKey === 'all') {
      return ['📚 全部专著'];
    }
    const targetBook = ALL_BOOKS.find((b) => b.categoryPath.includes(selectedCategoryKey));
    if (targetBook) {
      const idx = targetBook.categoryPath.indexOf(selectedCategoryKey);
      if (idx !== -1) {
        return targetBook.categoryLabels.slice(0, idx + 1);
      }
    }
    return ['🤖 人工智能 (AI)'];
  }, [selectedCategoryKey]);

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
            <Tag color="blue">5 部大师级技术专著</Tag>
            <Tag color="green">免密 AI 伴读已就绪</Tag>
          </Space>
        ),
        subTitle: '树形联动分类检索、AI 领域专属排版、骨架屏零卡顿阅读与 /book-craft 全自动无人值守出书闭环',
        extra: [
          <Input
            key="search"
            placeholder="搜索书名、标签或三级分类..."
            prefix={<SearchOutlined style={{ color: '#8c8c8c' }} />}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
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
      {/* 顶部多级树形联动分类控制器 */}
      <Card
        bordered={false}
        bodyStyle={{ padding: '16px 20px' }}
        style={{
          marginBottom: 20,
          borderRadius: 10,
          boxShadow: '0 2px 10px rgba(0,0,0,0.04)',
          background: '#fff',
        }}
      >
        <Row align="middle" justify="space-between" gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <Space align="center" size="middle" style={{ width: '100%' }}>
              <Text strong style={{ whiteSpace: 'nowrap' }}>
                <FolderOpenOutlined style={{ color: '#1677ff', marginRight: 6 }} />
                多级分类导航：
              </Text>
              <TreeSelect
                treeData={CATEGORY_TREE}
                value={selectedCategoryKey}
                onChange={(val) => setSelectedCategoryKey(val)}
                treeDefaultExpandAll
                placeholder="请选择一级/二级/三级分类..."
                style={{ minWidth: 320, width: '100%' }}
                dropdownStyle={{ maxHeight: 400, overflow: 'auto' }}
              />
            </Space>
          </Col>
          <Col xs={24} md={12} style={{ textAlign: 'right' }}>
            <Breadcrumb style={{ display: 'inline-block' }}>
              <Breadcrumb.Item>
                <a onClick={() => setSelectedCategoryKey('all')}>全部专著</a>
              </Breadcrumb.Item>
              {breadcrumbs.map((b, i) => (
                <Breadcrumb.Item key={i}>
                  <Text strong={i === breadcrumbs.length - 1} style={{ color: i === breadcrumbs.length - 1 ? '#1677ff' : undefined }}>
                    {b}
                  </Text>
                </Breadcrumb.Item>
              ))}
            </Breadcrumb>
          </Col>
        </Row>
      </Card>

      {/* 书籍网格 */}
      {filteredBooks.length === 0 ? (
        <Empty
          description="当前分类下暂无匹配书籍，请尝试切换上方多级分类或清空搜索词"
          style={{ padding: '60px 0' }}
        />
      ) : (
        <Row gutter={[24, 24]}>
          {filteredBooks.map((book) => {
            const progressPercent = Math.round((book.completedChapters / book.totalChapters) * 100);
            return (
              <Col xs={24} sm={24} md={12} lg={12} xl={8} key={book.id}>
                <Badge.Ribbon
                  text={book.badge || 'PROD'}
                  color={
                    book.id === 'harness-book'
                      ? 'blue'
                      : book.id === 'pi-agent-book'
                      ? 'gold'
                      : book.id === 'pi-core-book'
                      ? 'green'
                      : book.id === 'pi-practice-book'
                      ? 'purple'
                      : 'cyan'
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
                        <Tag
                          color="blue"
                          style={{
                            border: 'none',
                            background: 'rgba(22, 119, 255, 0.25)',
                            color: '#58a6ff',
                            fontWeight: 500,
                          }}
                        >
                          {book.categoryLabels[book.categoryLabels.length - 1]}
                        </Tag>
                        <span style={{ color: '#fff', fontSize: 12, opacity: 0.9 }}>
                          {book.completedChapters} / {book.totalChapters} 章节全量完工
                        </span>
                      </div>
                    </div>

                    {/* 书籍标题与简介 */}
                    <Title
                      level={5}
                      style={{ margin: '0 0 4px 0', fontSize: 16, fontWeight: 600, color: '#1f1f1f' }}
                    >
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
                          🎨 专属风格: {book.styleTheme}
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
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          fontSize: 12,
                          marginBottom: 4,
                        }}
                      >
                        <Text type="secondary">编写与验收进度</Text>
                        <Text strong style={{ color: '#52c41a' }}>
                          <CheckCircleOutlined style={{ marginRight: 4 }} />
                          100% (全量深度就绪)
                        </Text>
                      </div>
                      <Progress
                        percent={progressPercent}
                        status="success"
                        strokeColor="#52c41a"
                        size="small"
                      />
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
      )}

      {/* 内嵌阅读器 Modal */}
      {activeReadingBook && (
        <Modal
          title={
            <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
              <Space>
                <BookOutlined style={{ color: '#1677ff' }} />
                <span style={{ fontWeight: 600 }}>{activeReadingBook.title}</span>
                <Tag color="green">AI 伴读 Copilot 免密直连</Tag>
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
