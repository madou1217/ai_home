import { memo } from 'react';
import { FileTextOutlined } from '@ant-design/icons';
import MessageMarkdown from './MessageMarkdown';
import EventBlock from './EventBlock';
import evt from './EventBlock.module.css';

interface CandidatePlanBlockProps {
  value: string;
  mobile?: boolean;
  mdComponents?: any;
}

function CandidatePlanBlock({ value, mobile = false, mdComponents }: CandidatePlanBlockProps) {
  return (
    <EventBlock tone="plan" icon={<FileTextOutlined />} title="候选计划" collapsible={false} dense={mobile} aria-label="候选计划">
      {value ? (
        <div className={evt.prose}>
          <MessageMarkdown value={value} components={mdComponents} forceMarkdown />
        </div>
      ) : null}
    </EventBlock>
  );
}

export default memo(CandidatePlanBlock);
