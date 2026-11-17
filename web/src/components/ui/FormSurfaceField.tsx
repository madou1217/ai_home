import { cloneElement, useCallback, useLayoutEffect, useState, type ReactElement } from 'react';
import { flushSync } from 'react-dom';
import type { FormInstance } from 'antd';
import { flushActiveTransitionSync } from '@/services/view-transition';

interface FormSurfaceFieldProps {
  /** rc-field-form Field.getControlled 注入的当前表单字段值 */
  value?: unknown;
  /** rc-field-form Field.getControlled 注入的权威字段更新与校验触发器 */
  onChange?: (...args: unknown[]) => void;
  /** Form.Item 注入的可访问性控件 id */
  id?: string;
  /** 在 rc-field-form 写入 store 之前包裹预提交切换事务，保证先采集旧表单视图快照 */
  onBeforeFieldCommit: (commitFieldUpdate: () => void, rawFirstArg: unknown) => void;
  children: ReactElement<Record<string, unknown>>;
}

interface GuardedFormRecord {
  flushBeforeSubmit: () => void;
}

const guardedForms = new WeakMap<object, GuardedFormRecord>();
let pendingFormRenderCommit = false;

/**
 * 在使用 FormSurfaceField 的宿主表单组件（如 AddAccountModal、SshHostsPanel）中调用：
 * 幂等包裹 form.submit 与 form.validateFields，在任何提交或校验执行前同步冲刷挂起的
 * 预提交过渡事务及依赖其条件渲染的 Form.Item 挂载/卸载（INDEPENDENT-3 #2），
 * 杜绝快速切换认证方式后立刻提交时读到旧字段值或触发旧必填校验，同时完整保留表单草稿。
 */
export function useFormSubmitTransitionGuard(form: FormInstance | null | undefined): void {
  const [, setSyncTick] = useState(0);

  const flushBeforeSubmit = useCallback(() => {
    flushActiveTransitionSync();
    if (pendingFormRenderCommit) {
      pendingFormRenderCommit = false;
      try {
        flushSync(() => {
          setSyncTick((prev) => prev + 1);
        });
      } catch (_error) {
        // 已处于 React 渲染栈内时忽略。
      }
    }
  }, []);

  if (form && typeof form === 'object') {
    const existing = guardedForms.get(form);
    if (existing) {
      existing.flushBeforeSubmit = flushBeforeSubmit;
    } else {
      const rawSubmit = form.submit.bind(form);
      const rawValidateFields = form.validateFields.bind(form);
      const record: GuardedFormRecord = { flushBeforeSubmit };
      guardedForms.set(form, record);
      form.submit = () => {
        record.flushBeforeSubmit();
        rawSubmit();
      };
      form.validateFields = ((...args: Parameters<typeof rawValidateFields>) => {
        record.flushBeforeSubmit();
        return rawValidateFields(...args);
      }) as typeof form.validateFields;
    }
  }
}

/**
 * Form.Item 受控字段的预提交事务适配器（见 COORDINATOR-REVIEW-08-FORM-CHECK.md）：
 *
 * rc-field-form 的 `Field.getControlled` 会在子组件的 `onChange` 之前先执行
 * `dispatch({ type: 'updateValue' })`；若直接在 `<Select onChange>` 里包事务，调用时 store 已更新，
 * 只能截到新帧而丢失离场帧。将本组件作为 `Form.Item` 的直接子元素后，`onChange` 即为权威的
 * store 写入触发器，从而在状态落盘前截取真实旧帧并保持 touched / dirty / 校验 / 草稿语义恰好执行一次。
 */
export default function FormSurfaceField({
  value,
  onChange,
  id,
  onBeforeFieldCommit,
  children,
}: FormSurfaceFieldProps) {
  useLayoutEffect(() => {
    pendingFormRenderCommit = false;
  });

  const childOnChange = children.props.onChange as ((...args: unknown[]) => void) | undefined;
  return cloneElement(children, {
    id: (children.props.id as string | undefined) ?? id,
    value,
    onChange: (...args: unknown[]) => {
      pendingFormRenderCommit = true;
      onBeforeFieldCommit(() => {
        onChange?.(...args);
        childOnChange?.(...args);
      }, args[0]);
    },
  });
}
