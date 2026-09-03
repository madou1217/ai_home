import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Empty, Spin, Tag } from 'antd';
import { BranchesOutlined, ReloadOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import FileTypeIcon from '@/components/chat/FileTypeIcon';
import { gitReviewAPI } from '@/services/api';
import type { GitChangedFile, GitSummary } from '@/services/api';
import styles from '../project-workbench.module.css';

interface Props {
  projectPath: string;
  mobile?: boolean;
  // 三栏栏工具行集成：刷新动作与分支 chip 上移到栏头，传入后即隐藏面板内标题栏。
  registerRefresh?: (refresh: () => void) => void;
  onSummaryChange?: (summary: GitSummary | null) => void;
}

export default function ReviewPanel({ projectPath, mobile, registerRefresh, onSummaryChange }: Props) {
  const [summary, setSummary] = useState<GitSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<{ file: GitChangedFile; staged: boolean } | null>(null);
  const [diff, setDiff] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try { setSummary(await gitReviewAPI.summary(projectPath)); }
    catch (err) { setError(String((err as Error)?.message || err)); }
    setLoading(false);
  }, [projectPath]);

  useEffect(() => { void refresh(); }, [refresh]);

  // 向栏工具行暴露刷新动作与分支信息（仅三栏宿主传入）。
  useEffect(() => {
    registerRefresh?.(() => { void refresh(); });
  }, [registerRefresh, refresh]);
  useEffect(() => { onSummaryChange?.(summary); }, [onSummaryChange, summary]);

  const groups = useMemo(() => {
    const files = summary?.files || [];
    return [
      { key: 'staged', title: '已暂存', files: files.filter((f) => f.staged && !f.untracked), staged: true },
      { key: 'unstaged', title: '未暂存', files: files.filter((f) => f.unstaged && !f.untracked), staged: false },
      { key: 'untracked', title: '未跟踪', files: files.filter((f) => f.untracked), staged: false },
    ].filter((g) => g.files.length > 0);
  }, [summary]);

  const selectFile = useCallback(async (file: GitChangedFile, staged: boolean) => {
    setSelected({ file, staged });
    setDiffLoading(true);
    setDiff('');
    try {
      const result = await gitReviewAPI.diff(projectPath, file.path, staged);
      setDiff(result.content);
      setTruncated(result.truncated);
    } catch (err) {
      setDiff(`无法加载 diff: ${String((err as Error)?.message || err)}`);
      setTruncated(false);
    }
    setDiffLoading(false);
  }, [projectPath]);

  const diffView = (
    // 未选中文件时是空态：用常规表面色，避免整 pane 黑底吞掉 Empty 语义。
    <section className={`${styles.diffPane} ${selected ? '' : styles.diffPaneEmpty}`}>
      {!selected ? <Empty description="选择变更文件查看 Diff" /> : diffLoading ? <Spin /> : (
        <>
          <div className={styles.diffHeader}>
            {mobile ? <Button size="small" onClick={() => setSelected(null)}>返回</Button> : null}
            <span>{selected.file.path}</span>
            {truncated ? <Tag color="orange">已截断</Tag> : null}
          </div>
          <pre className={styles.diffContent}>{diff || (selected.file.untracked ? '未跟踪文件尚无 Git diff' : '无差异内容')}</pre>
        </>
      )}
    </section>
  );
  if (mobile && selected) return <div className={styles.reviewMobileDiff}>{diffView}</div>;

  return (
    <div className={styles.reviewPanel}>
      <aside className={styles.reviewSidebar}>
        {/* 标签页/移动端宿主没有栏工具行，保留面板内标题栏；三栏宿主下由栏头 chip 表达分支。 */}
        {!onSummaryChange ? (
          <div className={styles.reviewHeader}>
            <div className={styles.reviewBranch}><BranchesOutlined /><strong>{summary?.branch || 'Git'}</strong></div>
            <Button type="text" size="small" icon={<ReloadOutlined />} onClick={refresh} />
          </div>
        ) : null}
        {summary?.upstream ? (
          <div className={styles.reviewUpstream}>{summary.upstream} · ↑{summary.ahead} ↓{summary.behind}</div>
        ) : null}
        {loading ? <div className={styles.filesCentered}><Spin size="small" /></div> : null}
        {error ? <Alert type="error" message="无法读取 Git 状态" description={error} showIcon /> : null}
        {!loading && !error && groups.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="工作区无变更" /> : null}
        <div className={styles.reviewGroups}>
          {groups.map((group) => (
            <section key={group.key}>
              <div className={styles.reviewGroupTitle}>{group.title}<span>{group.files.length}</span></div>
              {group.files.map((file) => (
                <button
                  key={`${group.key}:${file.path}`}
                  type="button"
                  className={`${styles.reviewFile} ${selected?.file.path === file.path && selected.staged === group.staged ? styles.reviewFileActive : ''}`}
                  onClick={() => { void selectFile(file, group.staged); }}
                >
                  <FileTypeIcon filePath={file.path} size="small" />
                  <span title={file.path}>{file.path}</span>
                  <Tag bordered={false}>{file.status.trim() || '?'}</Tag>
                </button>
              ))}
            </section>
          ))}
        </div>
      </aside>
      {diffView}
    </div>
  );
}
