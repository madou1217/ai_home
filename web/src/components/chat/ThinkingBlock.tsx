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
    const lastLine = String(value || '').split('\n').filter((line) => line.trim()).pop() || '';
    return lastLine.length > 72 ? `${lastLine.slice(0, 72)}...` : lastLine;
  }, [value]);

  return (
    <EventBlock tone="thinking" icon={<BulbOutlined />} title="思考" preview={preview} dense={mobile} aria-label="思考过程">
      <div className={`${evt.prose} ${evt.scroll}`}>
        <MessageMarkdown value={value} components={components} forceMarkdown />
      </div>
    </EventBlock>
  );
}

export default memo(ThinkingBlock);
