// APNG 编码策略（自研 PNG 帧装配器，零依赖）。
// 结构：PNG 签名 + acTL(动画控制) + 首帧 IHDR + fcTL(seq0) + 首帧 IDAT… + IEND
//       + 后续帧 [fcTL + fdAT]×(n-1)。
// 除了首帧用 IDAT，其余帧都是 fcTL(帧头) + fdAT(帧数据，序号从 1 起)。
// 每一帧都是整个画面的完整快照（全画面混合模式），所以 dispose/blend 都是 none/source。

import type { EncodeAnimationRequest } from '../types';
import { getCaptureFormat } from '../format-catalog';
import { loadImageFromDataUrl, sleep } from '../frame-utils';

/** APNG 编码较重，超限则等比缩到该最长边内。 */
const APNG_MAX_SIZE = 800;
/** 每帧处理之间让出主线程一次。 */
const YIELD_MS = 0;

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type PngChunk = {
  type: string;
  /** 该 chunk 在 PNG 字节流里的起始偏移（含长度前缀 4 + 类型 4）。 */
  start: number;
  /** 数据长度（不含长度/类型/CRC）。 */
  length: number;
};

type ApngFrame = {
  /** 已编码好的单帧 PNG 字节。 */
  bytes: Uint8Array;
  delayNum: number;
  delayDen: number;
};

function scaleToApngBounds(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= APNG_MAX_SIZE) return { width, height };
  const ratio = APNG_MAX_SIZE / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio))
  };
}

let crcTableCache: Uint32Array | null = null;
function crc32Table(): Uint32Array {
  if (crcTableCache) return crcTableCache;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTableCache = table;
  return table;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset + offset, 4).setUint32(0, value >>> 0, false);
}

/** 组装一个完整 PNG chunk：长度 + 类型 + 数据 + CRC。 */
function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  writeUint32(chunk, 0, data.length);
  for (let index = 0; index < 4; index += 1) {
    chunk[4 + index] = type.charCodeAt(index);
  }
  chunk.set(data, 8);
  const table = crc32Table();
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  let crc = 0xffffffff;
  for (let index = 4; index < 8 + data.length; index += 1) {
    crc = table[(crc ^ chunk[index]) & 0xff] ^ (crc >>> 8);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  view.setUint32(8 + data.length, crc, false);
  return chunk;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
function iterateChunks(png: Uint8Array): PngChunk[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: PngChunk[] = [];
  let offset = 8; // 跳过签名
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);
    chunks.push({ type, start: offset, length });
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  return chunks;
}

/** 原样复制一个 chunk（含 4 长度 + 4 类型 + 数据 + 4 CRC）。 */
function copyChunk(png: Uint8Array, chunk: PngChunk): Uint8Array {
  return png.subarray(chunk.start, chunk.start + 12 + chunk.length);
}

/**
 * 抽取单帧 PNG 里连续的 IDAT 压缩流（zlib 流本身）。
 * 只用一次；首帧的 IDAT 会按原样整块复制，后续帧只取流喂 fdAT。
 */
function extractIdatStream(png: Uint8Array): Uint8Array {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const parts: Uint8Array[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset, false);
    const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);
    const dataStart = offset + 8;
    if (type === 'IDAT') {
      parts.push(png.subarray(dataStart, dataStart + length));
    }
    if (type === 'IEND') break;
    offset = dataStart + length + 4; // 跳过 CRC
  }
  return concatBytes(parts);
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('apng_encode_blob_empty'));
        return;
      }
      blob
        .arrayBuffer()
        .then((buffer) => resolve(new Uint8Array(buffer)))
        .catch(reject);
    }, 'image/png');
  });
}

async function pullFrameBytes(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  dataUrl: string
): Promise<Uint8Array> {
  const image = await loadImageFromDataUrl(dataUrl);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const bytes = await canvasToPngBytes(canvas);
  await sleep(YIELD_MS);
  return bytes;
}

function buildApngDelay(delayMs: number): { delayNum: number; delayDen: number } {
  // fcTL 的 delay 是分数：delayNum/delayDen 秒，两项都是 uint16。
  if (delayMs > 0 && delayMs <= 65535) return { delayNum: Math.round(delayMs), delayDen: 1000 };
  return { delayNum: Math.min(65535, Math.max(1, Math.round(delayMs / 10))), delayDen: 100 };
}

function buildFctlChunk(sequence: number, width: number, height: number, frame: ApngFrame): Uint8Array {
  const data = new Uint8Array(26);
  writeUint32(data, 0, sequence);
  writeUint32(data, 4, width);
  writeUint32(data, 8, height);
  writeUint32(data, 12, 0); // x offset
  writeUint32(data, 16, 0); // y offset
  const delay = new DataView(data.buffer, data.byteOffset + 20, 4);
  delay.setUint16(0, frame.delayNum, false);
  delay.setUint16(2, frame.delayDen, false);
  data[24] = 0; // dispose_op: APNG_DISPOSE_OP_NONE
  data[25] = 0; // blend_op: APNG_BLEND_OP_SOURCE
  return buildChunk('fcTL', data);
}

function buildFdatChunk(sequence: number, stream: Uint8Array): Uint8Array {
  const data = new Uint8Array(4 + stream.length);
  writeUint32(data, 0, sequence);
  data.set(stream, 4);
  return buildChunk('fdAT', data);
}

/** 把多个单帧 PNG 拼成一个 APNG（纯字节操作）。 */
function assembleApng(
  frames: ApngFrame[],
  idatStreams: Uint8Array[],
  width: number,
  height: number
): Uint8Array {
  const firstChunks = iterateChunks(frames[0].bytes);
  const ihdr = firstChunks.find((chunk) => chunk.type === 'IHDR');
  if (!ihdr) throw new Error('apng_first_frame_missing_ihdr');

  const parts: Uint8Array[] = [PNG_SIGNATURE];
  // acTL：num_frames + num_plays(0 = 无限循环)
  const actl = new Uint8Array(8);
  writeUint32(actl, 0, frames.length);
  writeUint32(actl, 4, 0);
  parts.push(buildChunk('acTL', actl));
  parts.push(copyChunk(frames[0].bytes, ihdr));
  parts.push(buildFctlChunk(0, width, height, frames[0]));
  for (const chunk of firstChunks) {
    if (chunk.type !== 'IDAT') continue;
    parts.push(copyChunk(frames[0].bytes, chunk));
  }
  parts.push(buildChunk('IEND', new Uint8Array(0)));

  let sequence = 1;
  for (let index = 1; index < frames.length; index += 1) {
    parts.push(buildFctlChunk(sequence++, width, height, frames[index]));
    parts.push(buildFdatChunk(sequence++, idatStreams[index]));
  }
  return concatBytes(parts);
}

export async function encodeApngAnimation(request: EncodeAnimationRequest): Promise<Blob> {
  const descriptor = getCaptureFormat('apng');
  const bounds = scaleToApngBounds(request.width, request.height);
  const canvas = document.createElement('canvas');
  canvas.width = bounds.width;
  canvas.height = bounds.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('frame_canvas_context_unavailable');

  const frames: ApngFrame[] = [];
  const idatStreams: Uint8Array[] = [];
  const total = request.frames.length;
  for (let index = 0; index < total; index += 1) {
    if (request.signal?.aborted) throw new DOMException('capture_aborted', 'AbortError');
    const bytes = await pullFrameBytes(context, canvas, request.frames[index].dataUrl);
    frames.push({ bytes, ...buildApngDelay(request.frameDelayMs) });
    idatStreams.push(extractIdatStream(bytes));
    request.onProgress?.(total > 0 ? (index + 1) / (total + 1) : 1);
  }

  // assembleApng 是纯字节操作，单独占进度最后一档。
  const assembled = assembleApng(frames, idatStreams, bounds.width, bounds.height);
  request.onProgress?.(1);
  return new Blob([assembled], { type: descriptor.mimeType });
}
