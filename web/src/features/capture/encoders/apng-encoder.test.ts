import { describe, expect, test } from 'bun:test';

import { assembleApngFromPngFrames } from './apng-encoder';

// 两张 2x2 单帧 PNG（红 / 蓝），IHDR 完全一致，用来验证 chunk 装配顺序。
const RED_2X2 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP8wwACLGCSAQANBAECv1AVswAAAABJRU5ErkJggg==';
const BLUE_2X2 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEklEQVR4nGNkYPjLwMDAwgAGAAsXAQPfmWhAAAAAAElFTkSuQmCC';

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

type ParsedChunk = {
  type: string;
  data: Uint8Array;
};

function parseChunks(bytes: Uint8Array): ParsedChunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: ParsedChunk[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    const dataStart = offset + 8;
    chunks.push({ type, data: bytes.subarray(dataStart, dataStart + length) });
    offset = dataStart + length + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function buildFrames(count: number): { bytes: Uint8Array; delayMs: number }[] {
  const red = decodeBase64(RED_2X2);
  const blue = decodeBase64(BLUE_2X2);
  return Array.from({ length: count }, (_value, index) => ({
    bytes: index % 2 === 0 ? red : blue,
    delayMs: 100
  }));
}

describe('APNG assembly', () => {
  test('keeps IHDR first, acTL before the first IDAT, and IEND last', () => {
    const assembled = assembleApngFromPngFrames(buildFrames(3), 2, 2);
    const chunks = parseChunks(assembled);
    const types = chunks.map((chunk) => chunk.type);

    // PNG 签名必须保留。
    expect(Array.from(assembled.subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    ]);
    expect(types[0]).toBe('IHDR');
    expect(types[types.length - 1]).toBe('IEND');
    expect(types.indexOf('acTL')).toBeGreaterThan(0);
    expect(types.indexOf('acTL')).toBeLessThan(types.indexOf('IDAT'));
    expect(types.indexOf('fcTL')).toBeLessThan(types.indexOf('IDAT'));
  });

  test('writes one fcTL per frame and one fdAT per non-first frame', () => {
    const assembled = assembleApngFromPngFrames(buildFrames(4), 2, 2);
    const chunks = parseChunks(assembled);
    const fctl = chunks.filter((chunk) => chunk.type === 'fcTL');
    const fdat = chunks.filter((chunk) => chunk.type === 'fdAT');

    expect(fctl).toHaveLength(4);
    expect(fdat).toHaveLength(3);

    // 序号从首帧 fcTL(0) 起连续递增，覆盖所有 fcTL/fdAT。
    const sequences = chunks
      .filter((chunk) => chunk.type === 'fcTL' || chunk.type === 'fdAT')
      .map((chunk) => readUint32(chunk.data, 0));
    expect(sequences).toEqual([0, 1, 2, 3, 4, 5, 6]);

    const actl = chunks.find((chunk) => chunk.type === 'acTL');
    expect(actl).toBeDefined();
    expect(readUint32(actl!.data, 0)).toBe(4);
    expect(readUint32(actl!.data, 4)).toBe(0);
  });

  test('encodes each frame delay as delayNum/delayDen seconds', () => {
    const frames = buildFrames(2).map((frame, index) => ({
      ...frame,
      delayMs: index === 0 ? 33 : 250
    }));
    const chunks = parseChunks(assembleApngFromPngFrames(frames, 2, 2));
    const fctl = chunks.filter((chunk) => chunk.type === 'fcTL');

    expect(fctl).toHaveLength(2);
    const readDelay = (data: Uint8Array) => ({
      num: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(20, false),
      den: new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(22, false)
    });
    expect(readDelay(fctl[0].data)).toEqual({ num: 33, den: 1000 });
    expect(readDelay(fctl[1].data)).toEqual({ num: 250, den: 1000 });
  });

  test('rejects frames with a different IHDR instead of emitting a broken file', () => {
    const frames = buildFrames(2);
    const mutated = new Uint8Array(frames[1].bytes);
    // IHDR 的 width 字段位于签名(8) + 长度(4) + 类型(4) 之后。
    mutated[16] = 0;
    mutated[17] = 0;
    mutated[18] = 0;
    mutated[19] = 3;

    expect(() =>
      assembleApngFromPngFrames([frames[0], { ...frames[1], bytes: mutated }], 2, 2)
    ).toThrow('apng_frame_layout_mismatch: 1');
  });
});
