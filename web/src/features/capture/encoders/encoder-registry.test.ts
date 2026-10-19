import { describe, expect, test } from 'bun:test';

import { getAnimationEncoder, listAnimationEncoders } from './encoder-registry';
import { listAnimationFormats } from '../format-catalog';

describe('capture encoder registry', () => {
  test('every animation format has a registered animation encoder', () => {
    for (const format of listAnimationFormats()) {
      const strategy = getAnimationEncoder(format.id);
      expect(typeof strategy.encodeAnimation).toBe('function');
      expect(strategy.format).toBe(format.id);
    }
  });

  test('registered encoders cover animation formats and nothing else', () => {
    const registered = listAnimationEncoders().map((strategy) => strategy.format).sort();
    expect(registered).toEqual(['apng', 'gif', 'webm']);
  });

  test('unknown format id is rejected with a clear error', () => {
    let message = '';
    try {
      // @ts-expect-error 通过 registry 的非法键
      getAnimationEncoder('mp4');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('animation_encoder_unregistered: mp4');
  });
});
