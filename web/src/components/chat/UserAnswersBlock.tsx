import { memo, useMemo } from 'react';
import { CheckCircleOutlined } from '@ant-design/icons';
import EventBlock from './EventBlock';
import evt from './EventBlock.module.css';

interface Props {
  value: string;
  mobile?: boolean;
}

type UserAnswerItem = {
  key: string;
  answers: string[];
};

export function parseUserAnswers(value: string): UserAnswerItem[] | null {
  try {
    const parsed = JSON.parse(value);
    const answersData = parsed?.answers || parsed;
    if (!answersData || typeof answersData !== 'object') return null;

    return Object.entries(answersData).map(([key, rawValue]) => {
      const valueAny = rawValue as any;
      const answers = Array.isArray(valueAny?.answers)
        ? valueAny.answers
        : (Array.isArray(valueAny) ? valueAny : [String(valueAny)]);
      return {
        key,
        answers: answers.map((item: unknown) => String(item)).filter(Boolean)
      };
    }).filter((item) => item.answers.length > 0);
  } catch {
    return null;
  }
}

function UserAnswersBlock({ value, mobile = false }: Props) {
  const answers = useMemo(() => parseUserAnswers(value), [value]);
  if (!answers || answers.length === 0) return null;

  return (
    <EventBlock tone="ask" icon={<CheckCircleOutlined />} title="用户回答" collapsible={false} dense={mobile} aria-label="用户回答">
      <div className={evt.keyvalList}>
        {answers.map((item) => (
          <div key={item.key}>
            <div className={evt.keyvalKey}>{item.key}</div>
            <div className={evt.chips}>
              {item.answers.map((answer, index) => (
                <span key={`${answer}-${index}`} className={evt.chip}>{answer}</span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </EventBlock>
  );
}

export default memo(UserAnswersBlock);
