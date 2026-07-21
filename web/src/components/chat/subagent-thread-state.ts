export type SubagentTranscriptLoadState = 'idle' | 'loading' | 'loaded' | 'error';

export type SubagentStatusTone = 'neutral' | 'running' | 'success' | 'attention' | 'failed';

export type SubagentStatusPresentation = {
  label: string;
  tone: SubagentStatusTone;
  dot: boolean;
};

export function shouldLoadSubagentTranscript(
  open: boolean,
  loadState: SubagentTranscriptLoadState
) {
  return open && loadState === 'idle';
}

export function getSubagentStatusPresentation(
  taskStatus: string,
  loadState: SubagentTranscriptLoadState
): SubagentStatusPresentation {
  if (loadState === 'loading') return { label: '加载中', tone: 'running', dot: true };
  if (loadState === 'loaded') return { label: '已加载', tone: 'success', dot: false };
  if (loadState === 'error') return { label: '加载失败', tone: 'failed', dot: false };

  const normalizedStatus = String(taskStatus || '').trim().toLowerCase();
  if (normalizedStatus === 'completed' || normalizedStatus === 'complete' || normalizedStatus === 'closed') {
    return { label: '已完成', tone: 'success', dot: false };
  }
  if (normalizedStatus === 'failed' || normalizedStatus === 'error') {
    return { label: '失败', tone: 'failed', dot: false };
  }
  if (normalizedStatus === 'interrupted' || normalizedStatus === 'cancelled' || normalizedStatus === 'canceled') {
    return { label: '已中断', tone: 'attention', dot: false };
  }
  return { label: '可查看', tone: 'neutral', dot: false };
}

export function getSubagentResultStatusPresentation(
  result: string
): SubagentStatusPresentation {
  const normalizedResult = String(result || '').trim();
  const lowerResult = normalizedResult.toLowerCase();
  const spawnFailed = lowerResult.includes('collab spawn failed')
    || lowerResult.includes('agent thread limit reached')
    || normalizedResult.includes('子代理创建失败');
  if (spawnFailed) return { label: '未创建', tone: 'failed', dot: false };
  if (/无产出|被中断|仍在运行/.test(normalizedResult)) {
    return { label: '中断/运行中', tone: 'attention', dot: true };
  }
  if (normalizedResult) return { label: '已完成', tone: 'success', dot: false };
  return { label: '运行中', tone: 'running', dot: true };
}
