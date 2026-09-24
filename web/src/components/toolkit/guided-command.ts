export interface GuidedCommandParameter {
  key: string;
  label: string;
  placeholder: string;
}

export interface GuidedCommandTask {
  id: string;
  label: string;
  command: string;
  category: 'install' | 'update' | 'configure' | 'use' | 'uninstall' | 'inspect';
  platform?: string;
  description?: string;
  danger?: boolean;
  parameters?: GuidedCommandParameter[];
}

export const GUIDED_COMMAND_CATEGORY_LABELS: Readonly<Record<GuidedCommandTask['category'], string>> = Object.freeze({
  install: '安装',
  update: '更新',
  configure: '配置',
  use: '使用',
  uninstall: '卸载',
  inspect: '检查'
});

/** 把 `{{key}}` 占位符替换为用户填写的参数；未填写的保持占位符原样（复制按钮据此禁用）。 */
export function renderGuidedCommand(template: string, values: Record<string, string>) {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
    const value = values[key]?.trim();
    return value || `{{${key}}}`;
  });
}

/** 命令里仍残留未填写参数（`{{x}}` 或 `<name>` 形式）时不允许复制。 */
export const UNRESOLVED_COMMAND_PARAMETER = /\{\{[^}]+\}\}|<[a-z][a-z0-9_-]*>/i;

export function missingGuidedParameters(task: GuidedCommandTask | undefined, values: Record<string, string>) {
  return (task?.parameters || []).filter((parameter) => !values[parameter.key]?.trim());
}
