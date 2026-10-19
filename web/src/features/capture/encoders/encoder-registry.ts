// 动画编码策略注册表（工厂/注册表模式）。
// 新增一种动画格式 = 在 format-catalog 加描述符 + 在这里注册一个策略；
// 派发侧永远不写 `if (fmt === '...')`。

import type { AnimationCaptureFormatId, CaptureEncoderStrategy } from '../types';
import { encodeApngAnimation } from './apng-encoder';
import { encodeGifAnimation } from './gif-encoder';
import { encodeWebmAnimation } from './webm-encoder';

const ANIMATION_ENCODERS: Record<AnimationCaptureFormatId, CaptureEncoderStrategy> = {
  gif: { format: 'gif', encodeAnimation: encodeGifAnimation },
  apng: { format: 'apng', encodeAnimation: encodeApngAnimation },
  webm: { format: 'webm', encodeAnimation: encodeWebmAnimation }
};

export function getAnimationEncoder(format: AnimationCaptureFormatId): CaptureEncoderStrategy {
  const found = ANIMATION_ENCODERS[format];
  if (!found) throw new Error(`animation_encoder_unregistered: ${format}`);
  return found;
}

export function listAnimationEncoders(): CaptureEncoderStrategy[] {
  return Object.values(ANIMATION_ENCODERS);
}
