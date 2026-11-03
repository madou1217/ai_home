import { Checkbox, Input, InputNumber, Radio } from 'antd';
import type { InteractionField } from './interaction-view-model';
import type { AnswerValues, FieldAnswer } from './question-answer-policy';
import styles from './session-runtime.module.css';

const OTHER_OPTION_VALUE = '__aih_other__';

interface Props {
  readonly fields: readonly InteractionField[];
  readonly values: AnswerValues;
  readonly disabled: boolean;
  readonly onChange: (values: AnswerValues) => void;
}

export default function QuestionFields({ fields, values, disabled, onChange }: Props) {
  const setAnswer = (fieldId: string, answer: FieldAnswer) => {
    onChange({ ...values, [fieldId]: answer });
  };
  return (
    <div className={styles.questionFields}>
      {fields.map((field, index) => (
        <QuestionField
          key={field.id}
          field={field}
          position={index + 1}
          count={fields.length}
          answer={values[field.id]}
          disabled={disabled}
          onChange={(answer) => setAnswer(field.id, answer)}
        />
      ))}
    </div>
  );
}

function QuestionField({
  field, position, count, answer, disabled, onChange,
}: {
  readonly field: InteractionField;
  readonly position: number;
  readonly count: number;
  readonly answer?: FieldAnswer;
  readonly disabled: boolean;
  readonly onChange: (answer: FieldAnswer) => void;
}) {
  return (
    <fieldset className={styles.questionField} disabled={disabled}>
      <legend>
        <small>{field.header || `问题 ${position}/${count}`}</small>
        <span>{field.label}{field.required ? ' *' : ''}</span>
      </legend>
      {field.description ? <p>{field.description}</p> : null}
      <QuestionFieldInput field={field} answer={answer} onChange={onChange} />
    </fieldset>
  );
}

function QuestionFieldInput({
  field, answer, onChange,
}: {
  readonly field: InteractionField;
  readonly answer?: FieldAnswer;
  readonly onChange: (answer: FieldAnswer) => void;
}) {
  if (field.type === 'single_select') {
    return <SingleChoiceInput field={field} answer={answer} onChange={onChange} />;
  }
  if (field.type === 'multi_select') {
    return <MultiChoiceInput field={field} answer={answer} onChange={onChange} />;
  }
  if (field.type === 'boolean') {
    return <BooleanInput answer={answer} onChange={onChange} />;
  }
  if (field.type === 'number' || field.type === 'integer') {
    return <NumberInput field={field} answer={answer} onChange={onChange} />;
  }
  return <TextAnswerInput field={field} answer={answer} onChange={onChange} />;
}

function SingleChoiceInput({
  field, answer, onChange,
}: {
  readonly field: InteractionField;
  readonly answer?: FieldAnswer;
  readonly onChange: (answer: FieldAnswer) => void;
}) {
  const selected = answer?.kind === 'option'
    ? answer.value
    : answer?.kind === 'other' ? OTHER_OPTION_VALUE : undefined;
  return (
    <>
      <Radio.Group
        className={styles.questionOptions}
        value={selected}
        onChange={(event) => onChange(
          event.target.value === OTHER_OPTION_VALUE
            ? { kind: 'other', value: '' }
            : { kind: 'option', value: String(event.target.value) },
        )}
      >
        {field.options.map((option) => (
          <Radio key={option.value} value={option.value}>
            <OptionText label={option.label} description={option.description} />
          </Radio>
        ))}
        {field.allowOther ? <Radio value={OTHER_OPTION_VALUE}>其他</Radio> : null}
      </Radio.Group>
      {answer?.kind === 'other' ? (
        <SecretAwareInput
          secret={field.secret}
          value={answer.value}
          placeholder="输入其他回答"
          onChange={(value) => onChange({ kind: 'other', value })}
        />
      ) : null}
    </>
  );
}

function MultiChoiceInput({
  field, answer, onChange,
}: {
  readonly field: InteractionField;
  readonly answer?: FieldAnswer;
  readonly onChange: (answer: FieldAnswer) => void;
}) {
  const current = answer?.kind === 'multi'
    ? answer
    : { kind: 'multi' as const, values: [] as readonly string[] };
  return (
    <Checkbox.Group
      className={styles.questionOptions}
      value={[...current.values]}
      onChange={(values) => onChange({ kind: 'multi', values: values.map(String) })}
    >
      {field.options.map((option) => (
        <Checkbox key={option.value} value={option.value}>
          <OptionText label={option.label} description={option.description} />
        </Checkbox>
      ))}
    </Checkbox.Group>
  );
}

function BooleanInput({
  answer, onChange,
}: {
  readonly answer?: FieldAnswer;
  readonly onChange: (answer: FieldAnswer) => void;
}) {
  return (
    <Radio.Group
      value={answer?.kind === 'boolean' ? answer.value : undefined}
      onChange={(event) => onChange({ kind: 'boolean', value: event.target.value === true })}
    >
      <Radio value={true}>是</Radio>
      <Radio value={false}>否</Radio>
    </Radio.Group>
  );
}

function NumberInput({
  field, answer, onChange,
}: {
  readonly field: InteractionField;
  readonly answer?: FieldAnswer;
  readonly onChange: (answer: FieldAnswer) => void;
}) {
  if (field.secret) {
    return (
      <Input.Password
        value={answer?.kind === 'number' ? String(answer.value) : ''}
        inputMode={field.type === 'integer' ? 'numeric' : 'decimal'}
        autoComplete="off"
        onChange={(event) => {
          const value = Number(event.target.value);
          if (Number.isFinite(value)) onChange({ kind: 'number', value });
        }}
      />
    );
  }
  return (
    <InputNumber
      value={answer?.kind === 'number' ? answer.value : undefined}
      precision={field.type === 'integer' ? 0 : undefined}
      onChange={(value) => {
        if (typeof value === 'number') onChange({ kind: 'number', value });
      }}
    />
  );
}

function TextAnswerInput({
  field, answer, onChange,
}: {
  readonly field: InteractionField;
  readonly answer?: FieldAnswer;
  readonly onChange: (answer: FieldAnswer) => void;
}) {
  return (
    <SecretAwareInput
      secret={field.secret}
      value={answer?.kind === 'text' ? answer.value : ''}
      onChange={(value) => onChange({ kind: 'text', value })}
    />
  );
}

function SecretAwareInput({
  secret, value, placeholder, onChange,
}: {
  readonly secret: boolean;
  readonly value: string;
  readonly placeholder?: string;
  readonly onChange: (value: string) => void;
}) {
  return secret ? (
    <Input.Password
      value={value}
      placeholder={placeholder}
      autoComplete="off"
      onChange={(event) => onChange(event.target.value)}
    />
  ) : (
    <Input.TextArea
      autoSize={{ minRows: 1, maxRows: 4 }}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function OptionText({
  label, description,
}: {
  readonly label: string;
  readonly description?: string;
}) {
  return (
    <span className={styles.questionOptionText}>
      <strong>{label}</strong>
      {description ? <small>{description}</small> : null}
    </span>
  );
}
