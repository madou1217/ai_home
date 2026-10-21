// 完整页面捕获的内容探测：静态克隆不执行脚本，因此脚本/Canvas 生成的内容
// 可能缺失；CSS 动画虽然会播放，但会从初始状态开始，与用户当前看到的进度不同。
// 这里只做廉价的源码级探测，用于在捕获后提示用户改切实时画面。

export type ScriptDependentReason = 'script' | 'canvas' | 'animation';

/** 去掉 HTML 注释，避免把注释里的示例代码误判成真实内容。 */
function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

export function detectScriptDependentHtml(html: string): ScriptDependentReason[] {
  if (!html) return [];
  const markup = stripComments(html);
  const reasons: ScriptDependentReason[] = [];
  if (/<script\b/i.test(markup)) reasons.push('script');
  if (/<canvas\b/i.test(markup)) reasons.push('canvas');
  if (
    /@keyframes\b/i.test(markup) ||
    /(?:^|[;"'\s{])animation(?:-name)?\s*:/i.test(markup)
  ) {
    reasons.push('animation');
  }
  return reasons;
}

export function describeScriptDependentReasons(reasons: ScriptDependentReason[]): string {
  return reasons
    .map((reason) => {
      if (reason === 'script') return '脚本';
      if (reason === 'canvas') return 'Canvas';
      return 'CSS 动画';
    })
    .join('、');
}
