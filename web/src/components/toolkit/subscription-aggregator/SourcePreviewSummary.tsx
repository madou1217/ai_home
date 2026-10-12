import { Typography } from 'antd';
import { describeSourcePreview, nameWithFlag, summarizeSkipReasons } from './aggregator-presentation';
import type { SourcePreviewState } from './use-source-preview';

const { Text } = Typography;

const MAX_LISTED_NODES = 8;

/** 解析预览的展示：识别结果一句话、前几个节点名、按原因合并的跳过说明。 */
export default function SourcePreviewSummary({ preview, loading, error }: SourcePreviewState) {
  if (error) return <Text type="danger">{error}</Text>;
  if (!preview) return loading ? <Text type="secondary">正在解析…</Text> : null;
  const names = preview.nodes.slice(0, MAX_LISTED_NODES).map((node) => nameWithFlag(node.name, node.flag));
  const more = preview.nodes.length > MAX_LISTED_NODES ? ` 等 ${preview.nodes.length} 个` : '';
  const reasons = summarizeSkipReasons(preview.skippedNodes);
  return (
    <div>
      <Text type={preview.nodes.length ? 'secondary' : 'warning'}>
        {describeSourcePreview(preview)}
        {loading ? '（更新中…）' : ''}
      </Text>
      {names.length > 0 && (
        <Text type="secondary" ellipsis={{ tooltip: `${names.join('、')}${more}` }} style={{ display: 'block' }}>
          {names.join('、')}
          {more}
        </Text>
      )}
      {reasons.length > 0 && (
        <Text type="warning" style={{ display: 'block' }}>
          跳过：{reasons.map((item) => (item.count > 1 ? `${item.text} ×${item.count}` : item.text)).join('；')}
        </Text>
      )}
    </div>
  );
}
