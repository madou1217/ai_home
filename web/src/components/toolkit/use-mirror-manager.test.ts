import { describe, expect, it } from 'bun:test';
import { mirrorKindsOf, mirrorStatusOf } from './use-mirror-manager';

describe('mirror plugin kinds', () => {
  it('uses the server plugin list when present', () => {
    const data = {
      ok: true,
      kinds: [{ id: 'cargo', name: 'cargo', label: 'Rust cargo', settingLabel: 'crates source' }],
      cargo: { current: 'https://rsproxy.cn', presets: [] }
    };
    expect(mirrorKindsOf(data).map((kind) => kind.id)).toEqual(['cargo']);
    expect(mirrorStatusOf(data, 'cargo')?.current).toBe('https://rsproxy.cn');
    expect(mirrorStatusOf(data, 'kinds')).toBeUndefined();
  });

  it('falls back to npm/pip for older servers', () => {
    expect(mirrorKindsOf({ ok: true }).map((kind) => kind.id)).toEqual(['npm', 'pip']);
  });
});
