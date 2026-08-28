import { memo, useMemo } from 'react';
import { BulbOutlined } from '@ant-design/icons';
import MessageMarkdown from './MessageMarkdown';
import EventBlock from './EventBlock';
import evt from './EventBlock.module.css';

interface Props {
  value: string;
  mobile?: boolean;
  components?: any;
}

function ThinkingBlock({ value, mobile = false, components }: Props) {
  const preview = useMemo(() => {
    const raw = String(value || '');
    if (!raw.trim()) return '正在思考...';
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const lastLine = lines[lines.length - 1] || '';
    if (!lastLine) return '';
    // 往前推着显示最新思考动态：显示最新产生的那段文本
    return lastLine.length > 70 ? `...${lastLine.slice(-65)}` : lastLine;
  }, [value]);

  return (
    <EventBlock
      tone="thinking"
      icon={<BulbOutlined />}
      title="思考"
      preview={preview}
      dense={mobile}
      aria-label="思考过程"
    >
      <div className={`${evt.prose} ${evt.scroll}`}>
        <MessageMarkdown value={value} components={components} forceMarkdown />
      </div>
    </EventBlock>
  );
}

export default memo(ThinkingBlock);
