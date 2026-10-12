import { List, Popover, Typography } from 'antd';
import { HistoryOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import { describePull, formatPullTime } from './aggregator-presentation';
import type { AggregatorFormatInfo, AggregatorPull } from './types';

const { Text } = Typography;

interface RecentPullsProps {
  pulls: AggregatorPull[] | undefined;
  formats: AggregatorFormatInfo[];
}

/** 最近拉取：最新一次直接显示，全部记录在弹层里；用来核对客户端有没有被正确识别。 */
export default function RecentPulls({ pulls, formats }: RecentPullsProps) {
  if (!pulls?.length) return <Text type="secondary">还没有客户端拉取过</Text>;
  const [latest] = pulls;
  const list = (
    <List
      size="small"
      dataSource={pulls}
      renderItem={(pull) => (
        <List.Item>
          <List.Item.Meta title={describePull(pull, formats)} description={formatPullTime(pull.at)} />
        </List.Item>
      )}
    />
  );
  return (
    <Popover title={`最近 ${pulls.length} 次拉取（服务重启后清空）`} content={list} trigger="click" placement="bottomLeft">
      <Button type="link" size="small" icon={<HistoryOutlined />}>
        {`最近拉取：${describePull(latest, formats)} · ${formatPullTime(latest.at)}`}
      </Button>
    </Popover>
  );
}
