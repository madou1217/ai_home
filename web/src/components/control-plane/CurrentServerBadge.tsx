import { Tag, Tooltip } from 'antd';
import { CloudServerOutlined, DesktopOutlined } from '@ant-design/icons';
import { useActiveServerContext } from '@/services/server-context';

/* 顶部当前 server 徽标（R1）：始终显示"数据来自哪台 server"，远端用醒目色，避免看串数据。 */
export default function CurrentServerBadge() {
  const ctx = useActiveServerContext();
  if (!ctx.profile) {
    return (
      <Tooltip title="尚未配置 Server">
        <Tag icon={<DesktopOutlined />} style={{ marginInlineEnd: 8 }}>未连接</Tag>
      </Tooltip>
    );
  }
  if (ctx.isLocal) {
    return (
      <Tag icon={<DesktopOutlined />} color="default" style={{ marginInlineEnd: 8 }}>本机</Tag>
    );
  }
  // 远端名压缩：取主机名首段（如 ec2-43-207-102-163），避免超长域名撑破布局。
  let shortName = ctx.displayName;
  try {
    const host = new URL(ctx.endpoint).hostname || ctx.displayName;
    shortName = host.split('.')[0] || host;
  } catch (_error) { /* 非 URL，用原名 */ }
  return (
    <Tooltip title={`数据来自远端 server：${ctx.endpoint}`}>
      <Tag
        icon={<CloudServerOutlined />}
        color="processing"
        style={{
          marginInlineEnd: 8,
          maxWidth: 220,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          verticalAlign: 'middle'
        }}
      >
        远端 · {shortName}
      </Tag>
    </Tooltip>
  );
}
