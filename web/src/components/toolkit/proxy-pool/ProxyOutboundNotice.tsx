import { Space, Tooltip } from 'antd';
import { ThunderboltOutlined, NodeIndexOutlined } from '@ant-design/icons';
import InlineNote from '@/components/ui/InlineNote';
import Button from '@/components/ui/AppButton';
import { outboundIssueText, type OutboundIssue } from './proxy-pool-utils';

interface ProxyOutboundNoticeProps {
  issue: OutboundIssue | null;
  dataPlaneReady: boolean;
  suggestPending: boolean;
  onSuggest: () => void;
  onManual: () => void;
}

/** 规则/全局模式缺少默认出口时的紧凑提示：说明哪些流量在退化为直连，并给出两个处理入口。 */
export default function ProxyOutboundNotice({ issue, dataPlaneReady, suggestPending, onSuggest, onManual }: ProxyOutboundNoticeProps) {
  if (!issue) return null;
  const text = outboundIssueText(issue);
  return (
    <InlineNote
      className="proxy-outbound-notice"
      tone="warning"
      description={text.description}
      action={(
        <Space size={8} wrap>
          <Tooltip title={dataPlaneReady ? '并发实测全部节点，列出最快的几个供确认' : '需要先启动代理核心'}>
            <Button
              size="small"
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={suggestPending}
              disabled={!dataPlaneReady}
              onClick={onSuggest}
            >
              测速并选最快
            </Button>
          </Tooltip>
          <Button size="small" icon={<NodeIndexOutlined />} onClick={onManual}>手动选择</Button>
        </Space>
      )}
    >
      {text.title}
    </InlineNote>
  );
}
