import React, { useState } from 'react';
import {
  Drawer,
  Form,
  Input,
  Radio,
  Button,
  Space,
  Typography,
  Card,
  Alert,
  Divider,
  Tag,
  message,
  Steps
} from 'antd';
import {
  BookOutlined,
  GithubOutlined,
  FileTextOutlined,
  ThunderboltOutlined,
  CheckCircleOutlined,
  CodeOutlined,
  PictureOutlined
} from '@ant-design/icons';

const { Text, Title, Paragraph } = Typography;

interface BookCraftDrawerProps {
  visible: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export const BookCraftDrawer: React.FC<BookCraftDrawerProps> = ({
  visible,
  onClose,
  onSuccess
}) => {
  const [form] = Form.useForm();
  const [mode, setMode] = useState<'continue' | 'github' | 'doc'>('continue');
  const [submitting, setSubmitting] = useState(false);
  const [generatedCommand, setGeneratedCommand] = useState<string>('');

  const handleModeChange = (val: any) => {
    setMode(val);
    form.resetFields();
  };

  const handleFinish = (values: any) => {
    setSubmitting(true);
    let cmd = '';

    if (mode === 'continue') {
      const readmePath = values.readmePath || 'docs/harness-book/README.md';
      cmd = `/loop 15m /book-craft continue ${readmePath}`;
    } else if (mode === 'github') {
      const repoUrl = values.repoUrl;
      const outDir = values.outDir || 'docs/my-new-book';
      cmd = `/book-craft generate --repo ${repoUrl} --out ${outDir}`;
    } else if (mode === 'doc') {
      const docPath = values.docPath;
      const outDir = values.outDir || 'docs/spec-book';
      cmd = `/book-craft generate --doc ${docPath} --out ${outDir}`;
    }

    setGeneratedCommand(cmd);
    setSubmitting(false);
    message.success('已就绪！您可在下方一键复制命令或在终端/Claude 中直接执行');
  };

  const handleCopy = () => {
    if (!generatedCommand) return;
    navigator.clipboard.writeText(generatedCommand);
    message.success('已复制到剪贴板！');
  };

  return (
    <Drawer
      title={
        <Space align="center">
          <BookOutlined style={{ color: '#1677ff', fontSize: 18 }} />
          <span style={{ fontWeight: 600, fontSize: 16 }}>
            ✨ book-craft 自动化出书与增量编撰中枢
          </span>
          <Tag color="blue">技能已装载</Tag>
        </Space>
      }
      placement="right"
      width={640}
      onClose={onClose}
      open={visible}
      extra={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button type="primary" onClick={() => form.submit()} loading={submitting}>
            生成出书任务
          </Button>
        </Space>
      }
    >
      <Alert
        message="工业级出书流 (Book Authoring Pipeline)"
        description="基于 Claude Skill (/book-craft) 与本地 aih-server 引擎，提供书籍大纲自动萃取、7大标准模块源码级撰写、8K AI 配图生成与单页 Web 阅读器自动化编译全流程。"
        type="info"
        showIcon
        style={{ marginBottom: 20 }}
      />

      <div style={{ marginBottom: 20 }}>
        <Text strong style={{ display: 'block', marginBottom: 8 }}>
          选择创作模式：
        </Text>
        <Radio.Group
          value={mode}
          onChange={(e) => handleModeChange(e.target.value)}
          buttonStyle="solid"
          style={{ width: '100%' }}
        >
          <Radio.Button value="continue" style={{ width: '33.33%', textAlign: 'center' }}>
            <BookOutlined style={{ marginRight: 6 }} />
            已有书籍增量续写
          </Radio.Button>
          <Radio.Button value="github" style={{ width: '33.33%', textAlign: 'center' }}>
            <GithubOutlined style={{ marginRight: 6 }} />
            GitHub 仓库出书
          </Radio.Button>
          <Radio.Button value="doc" style={{ width: '33.33%', textAlign: 'center' }}>
            <FileTextOutlined style={{ marginRight: 6 }} />
            技术文档逆向出书
          </Radio.Button>
        </Radio.Group>
      </div>

      <Form
        form={form}
        layout="vertical"
        onFinish={handleFinish}
        initialValues={{
          readmePath: 'docs/pi-agent-book/README.md',
          outDir: 'docs/architecture-book',
        }}
      >
        {mode === 'continue' && (
          <Card size="small" title="增量续写配置" style={{ marginBottom: 16 }}>
            <Form.Item
              name="readmePath"
              label="目标书籍索引路径 (README.md)"
              rules={[{ required: true, message: '请输入书籍 README.md 路径' }]}
              extra="系统将自动扫描目录中标记为 [待编写] 的第一个小节，完成深度撰写、AI 作图并打勾"
            >
              <Input placeholder="docs/pi-agent-book/README.md" prefix={<BookOutlined />} />
            </Form.Item>
          </Card>
        )}

        {mode === 'github' && (
          <Card size="small" title="GitHub 仓库解析配置" style={{ marginBottom: 16 }}>
            <Form.Item
              name="repoUrl"
              label="GitHub 仓库公开链接 / 本地仓库路径"
              rules={[{ required: true, message: '请输入 GitHub 仓库地址' }]}
              extra="自动克隆/分析目标源码，萃取 5~6 篇核心架构大纲并自动化分批撰写"
            >
              <Input placeholder="https://github.com/owner/repository" prefix={<GithubOutlined />} />
            </Form.Item>
            <Form.Item
              name="outDir"
              label="产物输出目录"
              rules={[{ required: true, message: '请输入输出目录' }]}
            >
              <Input placeholder="docs/my-awesome-book" />
            </Form.Item>
          </Card>
        )}

        {mode === 'doc' && (
          <Card size="small" title="技术读物与规范出书" style={{ marginBottom: 16 }}>
            <Form.Item
              name="docPath"
              label="源读物 / 规范文档路径"
              rules={[{ required: true, message: '请输入文档路径' }]}
              extra="基于现有长文档或架构规范，扩写为 20+ 小节的工业级技术专著"
            >
              <Input placeholder="docs/functional-matrix.md" prefix={<FileTextOutlined />} />
            </Form.Item>
            <Form.Item
              name="outDir"
              label="产物输出目录"
              rules={[{ required: true, message: '请输入输出目录' }]}
            >
              <Input placeholder="docs/spec-book" />
            </Form.Item>
          </Card>
        )}
      </Form>

      {generatedCommand && (
        <Card
          size="small"
          title={
            <Space>
              <ThunderboltOutlined style={{ color: '#52c41a' }} />
              <span style={{ fontWeight: 600 }}>生成出的 Claude 出书执行指令</span>
            </Space>
          }
          style={{
            background: 'rgba(82, 196, 26, 0.05)',
            borderColor: 'rgba(82, 196, 26, 0.3)',
            marginTop: 16,
          }}
        >
          <Paragraph
            copyable
            code
            style={{
              fontSize: 13,
              margin: '8px 0',
              padding: '8px 12px',
              background: '#0d1117',
              color: '#58a6ff',
              borderRadius: 6,
            }}
          >
            {generatedCommand}
          </Paragraph>
          <Space style={{ marginTop: 8 }}>
            <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleCopy}>
              复制执行命令
            </Button>
            <Text type="secondary" style={{ fontSize: 12 }}>
              可直接在 Claude 对话框粘贴执行，开启无人值守自动写书与绘图
            </Text>
          </Space>
        </Card>
      )}

      <Divider />

      <Title level={5}>🎨 出书核心特性支持</Title>
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <div>
          <Tag color="purple">8K AI 插画</Tag>
          <Text type="secondary" style={{ fontSize: 13 }}>
            自动调用本地 aih-server (gemini-3.1-flash-image) 1:1 精确概念作图
          </Text>
        </div>
        <div>
          <Tag color="cyan">双语矢量流程图</Tag>
          <Text type="secondary" style={{ fontSize: 13 }}>
            自动生成中英双语 Native Rich-HTML 卡片与 Mermaid 状态机
          </Text>
        </div>
        <div>
          <Tag color="blue">单页 Web 阅读器</Tag>
          <Text type="secondary" style={{ fontSize: 13 }}>
            全自动编译生成 reader/book-data.js，内置 AI 划词即问 Copilot
          </Text>
        </div>
      </Space>
    </Drawer>
  );
};
