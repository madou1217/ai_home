import { memo, useState } from 'react';
import { Popover, Tooltip, Tag } from 'antd';
import {
  BulbOutlined,
  CodeOutlined,
  AuditOutlined,
  BugOutlined,
  ThunderboltOutlined,
  TranslationOutlined,
} from '@ant-design/icons';
import styles from './composer/composer.module.css';

export interface PromptPresetItem {
  id: string;
  title: string;
  icon: any;
  category: '代码开发' | '架构与评审' | '效率工具';
  template: string;
}

const PRESETS: PromptPresetItem[] = [
  {
    id: 'code-refactor',
    title: '代码重构与整洁规范',
    icon: <CodeOutlined />,
    category: '代码开发',
    template: '请帮我重构以下代码，遵循 SOLID 设计原则与 Clean Code 规范，严禁 God File，拆分为独立高内聚模块：\n\n```\n\n```',
  },
  {
    id: 'code-review',
    title: 'AIH Codex/Claude 双模型审查',
    icon: <AuditOutlined />,
    category: '架构与评审',
    template: '请作为资深架构师对这段实现进行端到端 Code Review，重点审查：1. 状态一致性 2. 内存泄漏隐患 3. 边界异常处理：\n\n',
  },
  {
    id: 'bug-reproduce',
    title: 'Bug 定位与单测复现',
    icon: <BugOutlined />,
    category: '代码开发',
    template: '我遇到了一个 Bug，表现为：\n请帮我分析潜在根因，并给出针对性的 Node.js / Playwright 复现测试用例与最小修复代码。',
  },
  {
    id: 'perf-optimize',
    title: '渲染性能与 60fps 优化',
    icon: <ThunderboltOutlined />,
    category: '效率工具',
    template: '请分析以下前端组件在高频数据流更新下的性能瓶颈，利用 requestAnimationFrame、虚拟滚动或节点细粒度订阅进行 60fps 丝滑优化：\n\n',
  },
  {
    id: 'doc-summarize',
    title: '结构化演进矩阵总结',
    icon: <TranslationOutlined />,
    category: '效率工具',
    template: '请根据我们的最新改动，输出清晰的【已完成清单】与【待交付 TODO 清单】结构化矩阵汇报：\n\n',
  },
];

export interface PromptPresetsCapsuleProps {
  onSelect: (template: string) => void;
  mobile?: boolean;
}

/**
 * HarmonyOS 6 灵感预设与指令模版灵动胶囊 (PromptPresetsCapsule)
 * 支持分类流光卡片展示、一键注入 Composer
 */
export const PromptPresetsCapsule = memo(function PromptPresetsCapsule({
  onSelect,
  mobile = false,
}: PromptPresetsCapsuleProps) {
  const [open, setOpen] = useState(false);

  const content = (
    <div className={styles.promptPresetPopover}>
      <div className={styles.promptPresetHeader}>
        <span className={styles.promptPresetTitle}>
          <BulbOutlined /> 灵感预设与指令模版
        </span>
        <Tag color="processing" className={styles.promptPresetTag}>
          HarmonyOS 6
        </Tag>
      </div>

      <div className={styles.promptPresetGrid}>
        {PRESETS.map((p) => (
          <div
            key={p.id}
            className={styles.promptPresetCard}
            onClick={() => {
              setOpen(false);
              onSelect(p.template);
            }}
          >
            <div className={styles.promptPresetCardIcon}>{p.icon}</div>
            <div className={styles.promptPresetCardText}>
              <div className={styles.promptPresetCardTitle}>{p.title}</div>
              <div className={styles.promptPresetCardCategory}>{p.category}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <Popover
      content={content}
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="topLeft"
      overlayClassName={styles.promptPresetOverlay}
    >
      <Tooltip title="灵感指令预设" placement="top" mouseEnterDelay={0.3}>
        <button
          type="button"
          className={styles.promptPresetTriggerBtn}
          aria-label="灵感指令预设"
        >
          <BulbOutlined />
          {!mobile ? <span style={{ fontSize: 11, marginLeft: 3 }}>灵感</span> : null}
        </button>
      </Tooltip>
    </Popover>
  );
});

export default PromptPresetsCapsule;
