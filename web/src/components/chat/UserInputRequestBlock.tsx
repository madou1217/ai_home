import { memo, useMemo } from 'react';
import { CheckOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import EventBlock from './EventBlock';
import evt from './EventBlock.module.css';

interface RequestOption {
  label: string;
  value?: string;
  description?: string;
}

interface RequestQuestion {
  id?: string;
  header?: string;
  question: string;
  options?: RequestOption[];
}

interface Props {
  body: string;
  result?: string;
  mobile?: boolean;
}

function parseJsonObject(text: string) {
  try {
    const parsed = JSON.parse(String(text || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function normalizeAnswers(result?: string): Record<string, string[]> {
  const parsed = parseJsonObject(result || '');
  const rawAnswers = parsed && typeof parsed.answers === 'object' ? parsed.answers : {};
  return Object.entries(rawAnswers || {}).reduce<Record<string, string[]>>((acc, [key, value]) => {
    const answerValue = (value && typeof value === 'object' && Array.isArray((value as any).answers))
      ? (value as any).answers
      : Array.isArray(value)
        ? value
        : value == null
          ? []
          : [value];
    acc[key] = answerValue.map((item: unknown) => String(item || '')).filter(Boolean);
    return acc;
  }, {});
}

function parseRequestQuestions(body: string): RequestQuestion[] {
  const parsed = parseJsonObject(body);
  const questions = Array.isArray((parsed as any)?.questions) ? (parsed as any).questions : [];
  return questions
    .map((question: any) => ({
      id: String(question?.id || '').trim(),
      header: String(question?.header || '').trim(),
      question: String(question?.question || '').trim(),
      options: Array.isArray(question?.options)
        ? question.options.map((option: any) => ({
            label: String(option?.label || '').trim(),
            value: option?.value == null ? undefined : String(option.value).trim(),
            description: option?.description == null ? undefined : String(option.description).trim()
          })).filter((option: RequestOption) => option.label)
        : []
    }))
    .filter((question: RequestQuestion) => question.question);
}

function isOptionSelected(option: RequestOption, answers: string[]) {
  if (answers.length === 0) return false;
  const candidates = [option.label, option.value].filter(Boolean).map((item) => String(item));
  return answers.some((answer) =>
    candidates.some((candidate) => answer === candidate || answer.includes(candidate) || candidate.includes(answer))
  );
}

function UserInputRequestBlock({ body, result = '', mobile = false }: Props) {
  const questions = useMemo(() => parseRequestQuestions(body), [body]);
  const answers = useMemo(() => normalizeAnswers(result), [result]);

  if (questions.length === 0) return null;

  return (
    <EventBlock
      tone="ask"
      icon={<QuestionCircleOutlined />}
      title="需要用户确认"
      collapsible={false}
      dense={mobile}
      meta={<span className={evt.metaText}>{`${questions.length} 项`}</span>}
      aria-label="需要用户确认"
    >
      <div className={evt.qList}>
        {questions.map((question, index) => {
          const questionKey = question.id || question.header || String(index);
          const answerList = answers[questionKey] || [];
          return (
            <div key={questionKey}>
              <div className={evt.qTitle}>
                {question.header ? <span className={evt.qBadge}>{question.header}</span> : null}
                <span>{question.question}</span>
              </div>
              {question.options && question.options.length > 0 ? (
                <div className={evt.options}>
                  {question.options.map((option) => {
                    const selected = isOptionSelected(option, answerList);
                    return (
                      <div
                        key={`${questionKey}:${option.label}`}
                        className={`${evt.option}${selected ? ` ${evt.optionSelected}` : ''}`}
                      >
                        <div className={evt.optionLabel}>
                          <span>{option.label}</span>
                          {selected ? <CheckOutlined /> : null}
                        </div>
                        {option.description ? (
                          <div className={evt.optionDesc}>{option.description}</div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {answerList.length > 0 && (!question.options || question.options.length === 0) ? (
                <div className={evt.chips}>
                  {answerList.map((answer) => <span key={answer} className={evt.chip}>{answer}</span>)}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </EventBlock>
  );
}

export default memo(UserInputRequestBlock);
