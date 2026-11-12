import { Modal, Space, Tag, Typography } from 'antd';
import type { AccountActivityResult } from '@/types';

// 纯展示弹窗：账号活动（签到 / 领臭鸡蛋）的执行结果。
// 状态与请求都留在页面（Accounts.tsx），这里只按结果渲染，符合「弹窗状态留页面」的拆分约定。

const STATUS_TEXT: Record<string, string> = {
  claimed: '已领取',
  already_claimed: '已领过',
  nothing_claimable: '暂无可领',
  dry_run: '仅预览',
  not_applicable: '不适用',
  error: '失败'
};

const STATUS_COLOR: Record<string, string> = {
  claimed: 'success',
  already_claimed: 'processing',
  nothing_claimable: 'default',
  dry_run: 'default',
  not_applicable: 'default',
  error: 'error'
};

function describeResult(result: AccountActivityResult): string {
  if (result.status === 'error') {
    return [result.error, result.message].filter(Boolean).join(' · ') || '未知错误';
  }
  if (result.status === 'claimed') {
    if (result.plan && result.plan.name) return result.plan.name;
    if (Number(result.credits) > 0) return `+${result.credits} Credits`;
    return result.message || '领取成功';
  }
  if (result.status === 'already_claimed') {
    return result.message || '本次窗口已经领取过';
  }
  if (result.status === 'nothing_claimable') {
    return '当前没有开放中的活动';
  }
  return result.message || '';
}

function countByStatus(results: AccountActivityResult[]) {
  const counts: Record<string, number> = {};
  for (const result of results) {
    const key = result.status || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export interface AccountActivityModalProps {
  open: boolean;
  /** 动作名（签到 / 领臭鸡蛋），由页面按实际执行的动作传入。 */
  title?: string;
  results: AccountActivityResult[];
  onClose: () => void;
}

export function AccountActivityModal({ open, title, results, onClose }: AccountActivityModalProps) {
  const counts = countByStatus(results);
  const summary = [
    counts.claimed ? `领取 ${counts.claimed}` : '',
    counts.already_claimed ? `已领 ${counts.already_claimed}` : '',
    counts.nothing_claimable ? `无可领 ${counts.nothing_claimable}` : '',
    counts.error ? `失败 ${counts.error}` : ''
  ].filter(Boolean);

  return (
    <Modal
      title={title || '账号活动'}
      open={open}
      onCancel={onClose}
      onOk={onClose}
      okText="知道了"
      cancelButtonProps={{ style: { display: 'none' } }}
      width={620}
      destroyOnClose
    >
      {summary.length > 0 ? (
        <Space size={6} wrap style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary">结果</Typography.Text>
          {summary.map((item) => (
            <Tag key={item} style={{ marginInlineEnd: 0 }}>{item}</Tag>
          ))}
        </Space>
      ) : null}
      {results.length === 0 ? (
        <Typography.Text type="secondary">没有可领取的活动。</Typography.Text>
      ) : (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          {results.map((result) => {
            const key = `${result.provider}:${result.accountRef}:${result.actionId || ''}`;
            return (
              <div
                key={key}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                  paddingBottom: 10,
                  borderBottom: '1px solid var(--color-border, rgba(0, 0, 0, 0.06))'
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {result.displayName || result.accountRef || result.provider}
                  </div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {result.provider}
                  </Typography.Text>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, maxWidth: '55%' }}>
                  <Tag color={STATUS_COLOR[result.status] || 'default'} style={{ marginInlineEnd: 0 }}>
                    {STATUS_TEXT[result.status] || result.status}
                  </Tag>
                  <Typography.Text type="secondary" style={{ fontSize: 12, textAlign: 'right' }}>
                    {describeResult(result)}
                  </Typography.Text>
                </div>
              </div>
            );
          })}
        </Space>
      )}
    </Modal>
  );
}

export default AccountActivityModal;
