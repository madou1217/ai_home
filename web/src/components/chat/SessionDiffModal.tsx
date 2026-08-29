import { memo, useMemo, useState } from 'react';
import { Modal, Radio, Tag, Empty } from 'antd';
import {
  DiffOutlined,
  SwapOutlined,
  CopyOutlined,
  CheckOutlined,
} from '@ant-design/icons';
import type { ChatMessage } from '@/types';
import styles from './chat.module.css';

export interface SessionDiffModalProps {
  open: boolean;
  onClose: () => void;
  originalMessages: ChatMessage[];
  forkedMessages: ChatMessage[];
  originalTitle?: string;
  forkedTitle?: string;
}

interface LineDiff {
  type: 'same' | 'added' | 'removed';
  content: string;
  lineNumLeft?: number;
  lineNumRight?: number;
}

function computeSimpleDiff(textA: string, textB: string): LineDiff[] {
  const linesA = textA.split('\n');
  const linesB = textB.split('\n');
  const result: LineDiff[] = [];

  const maxLen = Math.max(linesA.length, linesB.length);
  let leftNum = 1;
  let rightNum = 1;

  for (let i = 0; i < maxLen; i++) {
    const a = linesA[i];
    const b = linesB[i];

    if (a === undefined && b !== undefined) {
      result.push({ type: 'added', content: b, lineNumRight: rightNum++ });
    } else if (a !== undefined && b === undefined) {
      result.push({ type: 'removed', content: a, lineNumLeft: leftNum++ });
    } else if (a === b) {
      result.push({ type: 'same', content: a, lineNumLeft: leftNum++, lineNumRight: rightNum++ });
    } else {
      result.push({ type: 'removed', content: a, lineNumLeft: leftNum++ });
      result.push({ type: 'added', content: b, lineNumRight: rightNum++ });
    }
  }

  return result;
}

export const SessionDiffModal = memo(function SessionDiffModal({
  open,
  onClose,
  originalMessages,
  forkedMessages,
  originalTitle = '原始会话分支 (Main Branch)',
  forkedTitle = '派生会话分支 (Forked Branch)',
}: SessionDiffModalProps) {
  const [viewMode, setViewMode] = useState<'split' | 'unified'>('split');
  const [selectedTurn, setSelectedTurn] = useState<number>(0);
  const [copied, setCopied] = useState(false);

  // 提取对应轮次的 Assistant 回答进行 Diff
  const assistantTurns = useMemo(() => {
    const origAssistant = originalMessages.filter((m) => m.role === 'assistant');
    const forkAssistant = forkedMessages.filter((m) => m.role === 'assistant');
    const maxTurns = Math.max(origAssistant.length, forkAssistant.length);

    const turns: Array<{
      index: number;
      origContent: string;
      forkContent: string;
      diffs: LineDiff[];
    }> = [];

    for (let i = 0; i < maxTurns; i++) {
      const origText = String(origAssistant[i]?.content || '');
      const forkText = String(forkAssistant[i]?.content || '');
      turns.push({
        index: i,
        origContent: origText,
        forkContent: forkText,
        diffs: computeSimpleDiff(origText, forkText),
      });
    }
    return turns;
  }, [originalMessages, forkedMessages]);

  const activeTurn = assistantTurns[selectedTurn] || assistantTurns[0];

  const handleCopyForked = () => {
    if (!activeTurn?.forkContent) return;
    navigator.clipboard.writeText(activeTurn.forkContent).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={1080}
      centered
      title={
        <div className={styles.diffModalTitle}>
          <div className={styles.diffModalTitleText}>
            <DiffOutlined /> 会话分支版本差异对比 (Session Branch Diff)
          </div>
          <div className={styles.diffModalControls}>
            <Radio.Group
              size="small"
              value={viewMode}
              onChange={(e) => setViewMode(e.target.value)}
              buttonStyle="solid"
            >
              <Radio.Button value="split">并排比对 (Split)</Radio.Button>
              <Radio.Button value="unified">统一视图 (Unified)</Radio.Button>
            </Radio.Group>
          </div>
        </div>
      }
      className={styles.diffModal}
    >
      {assistantTurns.length === 0 ? (
        <Empty description="暂无助理回复对比数据" />
      ) : (
        <div className={styles.diffModalBody}>
          {assistantTurns.length > 1 ? (
            <div className={styles.diffTurnTabs}>
              {assistantTurns.map((turn, idx) => (
                <button
                  key={idx}
                  type="button"
                  className={`${styles.diffTurnTab} ${idx === selectedTurn ? styles.diffTurnTabActive : ''}`}
                  onClick={() => setSelectedTurn(idx)}
                >
                  轮次 #{idx + 1}
                </button>
              ))}
            </div>
          ) : null}

          <div className={styles.diffBannerHeader}>
            <div className={styles.diffBranchLabelLeft}>
              <Tag color="default">Origin</Tag> {originalTitle}
            </div>
            <div className={styles.diffBranchLabelRight}>
              <Tag color="processing">Fork</Tag> {forkedTitle}
              <button
                type="button"
                className={styles.diffCopyBtn}
                onClick={handleCopyForked}
                title="复制派生版本内容"
              >
                {copied ? <CheckOutlined style={{ color: '#52c41a' }} /> : <CopyOutlined />}
              </button>
            </div>
          </div>

          <div className={styles.diffContainer}>
            {viewMode === 'split' ? (
              <div className={styles.diffSplitView}>
                <div className={styles.diffSplitCol}>
                  <div className={styles.diffColHeader}>原始分支回答</div>
                  <pre className={styles.diffCodeArea}>
                    {activeTurn?.origContent || '(无内容)'}
                  </pre>
                </div>
                <div className={styles.diffSplitDivider} />
                <div className={styles.diffSplitCol}>
                  <div className={styles.diffColHeader}>派生分支回答</div>
                  <pre className={styles.diffCodeArea}>
                    {activeTurn?.forkContent || '(无内容)'}
                  </pre>
                </div>
              </div>
            ) : (
              <div className={styles.diffUnifiedView}>
                {activeTurn?.diffs.map((diff, index) => {
                  const typeClass =
                    diff.type === 'added'
                      ? styles.diffLineAdded
                      : diff.type === 'removed'
                      ? styles.diffLineRemoved
                      : styles.diffLineSame;
                  return (
                    <div key={index} className={`${styles.diffLine} ${typeClass}`}>
                      <span className={styles.diffLineNoLeft}>{diff.lineNumLeft || ''}</span>
                      <span className={styles.diffLineNoRight}>{diff.lineNumRight || ''}</span>
                      <span className={styles.diffLineMarker}>
                        {diff.type === 'added' ? '+' : diff.type === 'removed' ? '-' : ' '}
                      </span>
                      <span className={styles.diffLineContent}>{diff.content}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
});

export default SessionDiffModal;
