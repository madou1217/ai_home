/**
 * AI Home 自动进化与迭代规划引擎 (Self-Evolving Planner)
 * 吸收 dsh 2.0 自动发现、质量自检与双模型 (Codex / Claude) Review 契约
 *
 * 数据源标注（2026-08-31，F12/P1 落地）：
 * 本模块的 discoverEvolutionTasks() 是历史静态种子数据，无自动进化逻辑，
 * 且当前 web/src 内无任何消费方。真实的「自动发现盲区 + 下一轮规划」已由
 * scripts/evolution-scan.js 实现（扫描 docs/dsh-harmonyos-evolution-matrix.md 与
 * docs/session-b2ce4810-gap-tracker.md 的状态标记，❌/⚠️/❓ 优先排序并附出处行号），
 * review 门禁（需求原文+实现证据+验收问题清单 → aih codex/claude）同属该脚本
 * `review` 子命令。后续若前端需要展示规划，应消费 evolution-scan 的真实扫描结果，
 * 不得再以此静态数组为准。
 */
export interface EvolutionTask {
  id: string;
  category: '视觉重构' | '架构演进' | '动力学体验' | '工程质量';
  title: string;
  targetFiles: string[];
  status: 'pending' | 'in_progress' | 'reviewed' | 'completed';
  acceptanceCriteria: string[];
  codexReviewed?: boolean;
  claudeReviewed?: boolean;
}

export interface EvolutionPlan {
  version: string;
  generatedAt: string;
  summary: string;
  tasks: EvolutionTask[];
}

/**
 * 自动发现全站尚未鸿蒙化改造与 dsh 2.0 对齐的盲区
 */
export function discoverEvolutionTasks(): EvolutionTask[] {
  return [
    {
      id: 'TASK-HOS2-01',
      category: '视觉重构',
      title: '全站 Form/Select/Dropdown/Modal 统一使用 HOS6 字体阶梯与多层亚克力材质',
      targetFiles: ['web/src/styles/design-tokens.css', 'web/src/styles/mobile-shell.css'],
      status: 'pending',
      acceptanceCriteria: [
        '严格应用 8 级字体阶梯 (--hos-text-*)',
        '消除所有原生 Select/Button 的硬编码边框与纯黑背景',
        '全站 Dropdown 接入 32px 高斯模糊浮层与 Squircle 圆角',
      ],
    },
    {
      id: 'TASK-HOS2-02',
      category: '架构演进',
      title: 'Chat 会话集成 dsh 2.0 全链路状态机与极速重连',
      targetFiles: ['web/src/components/chat/MessageArea.tsx', 'web/src/pages/Chat.tsx'],
      status: 'pending',
      acceptanceCriteria: [
        '细粒度状态订阅，高频流式输入与 60fps 帧率稳固',
        '多轮思考微光扫描与打字机无重排锚定',
      ],
    },
    {
      id: 'TASK-HOS2-03',
      category: '工程质量',
      title: 'AIH Codex/Claude 双模型端到端自动化 Review 守卫',
      targetFiles: ['test/webui-e2e-suite.test.js'],
      status: 'pending',
      acceptanceCriteria: [
        '双端 Playwright 自动化零报错 (0 Error)',
        '移动端视口 (390x844) 零水平溢出 (0 Overflow)',
      ],
    },
  ];
}
