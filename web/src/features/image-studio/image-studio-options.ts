/** 影像工作台的参数选项与提示词模板（桌面控制台与移动端共用；取值即服务端接受的参数）。 */

export const IMAGE_STUDIO_PROMPT_PRESETS = [
  {
    label: '产品母版',
    value: 'Editorial product portrait on a warm neutral sweep, precise material texture, restrained shadows, art-directed studio light.',
  },
  {
    label: '空间概念',
    value: 'Architectural concept frame with disciplined geometry, natural material palette, cinematic daylight, human-scale details.',
  },
  {
    label: '视觉系统',
    value: 'A clear visual system study presented as a contact sheet, consistent subject, varied composition and lighting, production-ready art direction.',
  },
];

export const IMAGE_STUDIO_MAX_OUTPUT_COUNT = 10;

export const IMAGE_STUDIO_SIZE_VALUES = ['auto', '1024x1024', '1536x1024', '1024x1536'];

export function imageStudioBackgroundOptions(outputFormat: string) {
  return [
    { value: 'auto', label: '自动' },
    { value: 'opaque', label: '不透明' },
    { value: 'transparent', label: '透明', disabled: outputFormat === 'jpeg' },
  ];
}

export const IMAGE_STUDIO_OUTPUT_FORMAT_OPTIONS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
];

export const IMAGE_STUDIO_MODERATION_OPTIONS = [
  { value: 'auto', label: '自动' },
  { value: 'low', label: '低限制' },
];

export const IMAGE_STUDIO_PROMPT_MAX_LENGTH = 12000;
