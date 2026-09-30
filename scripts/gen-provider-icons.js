#!/usr/bin/env node
'use strict';

/**
 * 把 Provider 品牌图标 `web/src/assets/icons/<provider>.svg` 栅格化为 64x64 RGBA PNG，
 * 输出到 `assets/provider-icons/<provider>.png`。
 *
 * 该路径由 Provider 合同声明（`core/providers/builtins.go` 的 presentation
 * terminalIconAsset），供终端 profile 图标使用。SVG 是唯一来源：改图只改 SVG，再运行本脚本。
 *
 * 仓库内没有 SVG 栅格化依赖（无 sharp / rsvg / cairo），单色单路径图标由
 * scripts/svg-path-raster.js 解析栅格化；抗锯齿用 4x4 超采样求覆盖率。
 *
 * 用法：node scripts/gen-provider-icons.js
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { insidePolygons, parseSingleColorSvg, pathToPolygons } = require('./svg-path-raster');

const SIZE = 64;
const SS = 4; // 每像素的超采样倍数（SS x SS）

// CodeBuddy / WorkBuddy 家族共用同一官方图形，只以颜色区分（见各 SVG 头注释）。
const PROVIDERS = Object.freeze(['codebuddy', 'codebuddycn', 'workbuddy', 'workbuddycn']);

function render(svg) {
  const polygons = pathToPolygons(svg.d);
  const rows = [];
  for (let py = 0; py < SIZE; py += 1) {
    const row = Buffer.alloc(SIZE * 4);
    for (let px = 0; px < SIZE; px += 1) {
      let covered = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = svg.minX + ((px * SS + sx + 0.5) / (SIZE * SS)) * svg.width;
          const y = svg.minY + ((py * SS + sy + 0.5) / (SIZE * SS)) * svg.height;
          if (insidePolygons(polygons, x, y)) covered += 1;
        }
      }
      const offset = px * 4;
      row[offset] = svg.rgb[0];
      row[offset + 1] = svg.rgb[1];
      row[offset + 2] = svg.rgb[2];
      row[offset + 3] = Math.round((covered / (SS * SS)) * 255);
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
for (const provider of PROVIDERS) {
  const svgPath = path.join(repoRoot, 'web', 'src', 'assets', 'icons', `${provider}.svg`);
  const outPath = path.join(repoRoot, 'assets', 'provider-icons', `${provider}.png`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, encodePng(render(parseSingleColorSvg(fs.readFileSync(svgPath, 'utf8')))));
  console.log(`已生成 ${path.relative(repoRoot, outPath)} (${SIZE}x${SIZE})`);
}
