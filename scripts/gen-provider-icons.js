#!/usr/bin/env node
'use strict';

/**
 * 把 Provider 品牌记号（与 `web/src/assets/icons/<provider>.svg` 同形）栅格化为
 * 64x64 RGBA PNG，输出到 `assets/provider-icons/<provider>.png`。
 *
 * 该路径由 Provider 合同声明（`core/providers/builtins.go` 的 presentation
 * terminalIconAsset），供终端 profile 图标使用。CodeBuddy 家族的四个 Provider
 * （codebuddy / codebuddycn / workbuddy / workbuddycn）共用本脚本，几何各自独立。
 *
 * 为什么手写栅格化：仓库内没有 SVG 栅格化依赖（无 sharp / rsvg / cairo），
 * 而这些图形都是纯解析几何（圆角方 + 同心菱形 / 四角星 / 圆环），解析式判定
 * 比引入二进制依赖更可控、可复现，也不需要联网。
 *
 * 抗锯齿用 4x4 超采样求覆盖率；几何坐标统一在 1024 设计画布上，与 SVG 一一对应。
 *
 * 用法：node scripts/gen-provider-icons.js
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 64;
const SS = 4; // 每像素的超采样倍数（SS x SS）

// 设计画布与底板参数（三个图标共用同一套底板，保证列表里视觉重量一致）。
const DESIGN = 1024;
const HALF = DESIGN / 2; // 512
const RADIUS = 204.8; // 圆角半径（0.2 * 1024，与 kimi.svg 一致）
const BG = [0x10, 0x10, 0x10];

/**
 * 圆角方形的标准 SDF：d < 0 表示在形状内部。
 *
 * @param {number} dx 相对中心的设计坐标偏移
 * @param {number} dy 同上
 * @returns {boolean}
 */
function insideRoundedSquare(dx, dy) {
  const limit = HALF - RADIUS;
  const qx = Math.abs(dx) - limit;
  const qy = Math.abs(dy) - limit;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const dist = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - RADIUS;
  return dist < 0;
}

/**
 * 四角星（astroid）判定：(|dx|/a)^(2/3) + (|dy|/a)^(2/3) <= 1。
 * 尖角落在四个坐标轴上、半轴长 a，正好读作 "✦"。
 *
 * @param {number} dx
 * @param {number} dy
 * @param {number} a 半轴长
 * @returns {boolean}
 */
function insideAstroid(dx, dy, a) {
  const nx = Math.abs(dx) / a;
  const ny = Math.abs(dy) / a;
  if (nx > 1 || ny > 1) return false;
  return Math.pow(nx, 2 / 3) + Math.pow(ny, 2 / 3) <= 1;
}

/**
 * 各 Provider 的记号几何。每个 sample 返回 RGBA；底板之外返回全透明。
 * 形状选择与 `presentation(... terminalIcon ...)` 的文本记号对应：
 *   - codebuddy "❖"：菱形外环 + 品牌色内核
 *   - codebuddycn "✦"：四角星，内嵌同色内核
 *   - workbuddy "◉"：粗圆环 + 实心圆心（国际站）
 *   - workbuddycn "◍"：双同心圆环，中心留空（国内站，与 ◉ 一眼可分）
 */
const PROVIDER_ICONS = Object.freeze({
  codebuddy: {
    accent: [0x00, 0x52, 0xd9],
    sample(dx, dy) {
      const manhattan = Math.abs(dx) + Math.abs(dy);
      if (manhattan <= 128) return [...this.accent, 255];
      if (manhattan > 176 && manhattan <= 336) return [0xff, 0xff, 0xff, 255];
      return [...BG, 255];
    }
  },
  codebuddycn: {
    accent: [0x7a, 0x3f, 0xf2],
    sample(dx, dy) {
      if (insideAstroid(dx, dy, 176)) return [...this.accent, 255];
      if (insideAstroid(dx, dy, 384)) return [0xff, 0xff, 0xff, 255];
      return [...BG, 255];
    }
  },
  workbuddy: {
    accent: [0x12, 0xb7, 0x6a],
    sample(dx, dy) {
      const dist = Math.hypot(dx, dy);
      if (dist <= 118) return [...this.accent, 255];
      if (dist > 236 && dist <= 372) return [0xff, 0xff, 0xff, 255];
      return [...BG, 255];
    }
  },
  workbuddycn: {
    // 国内站沿用家族绿之外的站点紫，与 codebuddycn 的站点色一致。
    accent: [0x7a, 0x3f, 0xf2],
    sample(dx, dy) {
      const dist = Math.hypot(dx, dy);
      if (dist > 280 && dist <= 400) return [0xff, 0xff, 0xff, 255];
      if (dist > 102 && dist <= 198) return [...this.accent, 255];
      return [...BG, 255];
    }
  }
});

/**
 * 渲染为逐行 RGBA 字节。
 *
 * @param {{sample: (dx: number, dy: number) => number[]}} icon
 * @returns {Buffer[]}
 */
function render(icon) {
  const scale = DESIGN / (SIZE * SS);
  const rows = [];
  for (let py = 0; py < SIZE; py += 1) {
    const row = Buffer.alloc(SIZE * 4);
    for (let px = 0; px < SIZE; px += 1) {
      // 预乘 alpha 累加，避免透明像素把黑色混进边缘。
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aa = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const designX = (px * SS + sx + 0.5) * scale;
          const designY = (py * SS + sy + 0.5) * scale;
          const dx = designX - HALF;
          const dy = designY - HALF;
          const [r, g, b, a] = insideRoundedSquare(dx, dy)
            ? icon.sample(dx, dy)
            : [0, 0, 0, 0];
          ar += r * a;
          ag += g * a;
          ab += b * a;
          aa += a;
        }
      }
      const offset = px * 4;
      if (aa <= 0) {
        row[offset] = 0;
        row[offset + 1] = 0;
        row[offset + 2] = 0;
        row[offset + 3] = 0;
      } else {
        row[offset] = Math.round(ar / aa);
        row[offset + 1] = Math.round(ag / aa);
        row[offset + 2] = Math.round(ab / aa);
        row[offset + 3] = Math.round(aa / (SS * SS));
      }
    }
    rows.push(row);
  }
  return rows;
}

/**
 * 按 PNG 规范打包为 8bit RGBA。
 *
 * @param {Buffer[]} rows
 * @returns {Buffer}
 */
function encodePng(rows) {
  const raw = Buffer.concat(rows.map((row) => Buffer.concat([Buffer.from([0]), row])));

  const chunk = (tag, payload) => {
    const body = Buffer.concat([Buffer.from(tag, 'ascii'), payload]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(payload.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const repoRoot = path.join(__dirname, '..');
for (const [provider, icon] of Object.entries(PROVIDER_ICONS)) {
  const outPath = path.join(repoRoot, 'assets', 'provider-icons', `${provider}.png`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, encodePng(render(icon)));
  console.log(`已生成 ${path.relative(repoRoot, outPath)} (${SIZE}x${SIZE})`);
}
