'use strict';

// 阿里云验证码 2.0 交互式控件的 DOM 契约（2026-11-05 从线上动态 JS 取证）。
//
// 控件由 SDK 动态注入，**id 就是契约**（类名只作辅助，随时可能被改）：
//
//   #aliyunCaptcha-img-box.puzzle        背景图容器（300px 宽）
//     #aliyunCaptcha-img                 背景图（缺口画在上面）
//     #aliyunCaptcha-puzzle              拼图块（与背景同尺寸，块以外全透明）
//   #aliyunCaptcha-sliding-body          滑轨
//     #aliyunCaptcha-sliding-left        已拖过的进度条
//     #aliyunCaptcha-sliding-slider      把手（40px 宽）
//     #aliyunCaptcha-sliding-text-box
//       #aliyunCaptcha-sliding-text      "拖动滑块完成拼图" / "请按住滑块，拖动到最右边"
//
// 三类挑战：
//   TRACELESS  无痕验证，点一下直接出结果，不渲染滑轨；
//   SLIDING    "请按住滑块，拖动到最右边"，只有滑轨、没有拼图；
//   PUZZLE     "拖动滑块完成拼图"（含 INPAINTING 变体），滑轨 + 拼图块。
//
// 拼图块的位移和把手是 1:1 的（SDK 把两者的 left 设成同一个值），所以缺口在
// 图片里的 x 就是需要拖动的距离。缺口位置从**拼图块 PNG 的 alpha 包围盒**得到：
// 拼图块是整幅尺寸的透明图，只有那一块不透明。

const PUZZLE_SELECTOR = '#aliyunCaptcha-puzzle';
const IMAGE_BOX_SELECTOR = '#aliyunCaptcha-img-box';

/**
 * 一次性读取控件状态。轮询要便宜：只读 rect / naturalWidth / class，不碰像素。
 */
const WIDGET_PROBE_EXPRESSION = `(() => {
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const rectOf = (element) => {
    if (!visible(element)) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const slider = document.querySelector('#aliyunCaptcha-sliding-slider');
  const track = document.querySelector('#aliyunCaptcha-sliding-body');
  const puzzle = document.querySelector('#aliyunCaptcha-puzzle');
  const box = document.querySelector('${IMAGE_BOX_SELECTOR}');
  const text = document.querySelector('#aliyunCaptcha-sliding-text');
  const question = document.querySelector('#aliyunCaptcha-question');
  const outcome = window.__aihCaptchaOutcome || null;
  return {
    settled: Boolean(outcome),
    outcome: outcome ? { ok: outcome.ok === true, stage: outcome.stage || null } : null,
    slider: rectOf(slider),
    track: rectOf(track),
    trackClassName: track ? String(track.className || '') : '',
    trackState: track ? ['verified', 'fail', 'slided'].filter((name) => track.classList.contains(name)) : [],
    box: rectOf(box),
    puzzle: puzzle ? {
      present: true,
      visible: visible(puzzle),
      rect: rectOf(puzzle),
      naturalWidth: puzzle.naturalWidth || 0,
      naturalHeight: puzzle.naturalHeight || 0,
      complete: Boolean(puzzle.complete),
      src: String(puzzle.currentSrc || puzzle.src || '')
    } : null,
    text: text ? String(text.textContent || '').trim() : '',
    question: question ? String(question.textContent || '').trim() : ''
  };
})()`;

/**
 * 从控件快照判定挑战类型。纯函数，便于单测。
 * 返回 `{ kind, ready, ...snapshot }`，不是挑战时返回 null。
 */
function classifyChallenge(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const hasSlider = Boolean(snapshot.slider && snapshot.track);
  if (!hasSlider) {
    // 文字点选：没有滑轨，只有一个问题串。
    if (snapshot.question) return { ...snapshot, kind: 'text-click', ready: true };
    return null;
  }
  const puzzlePresent = Boolean(snapshot.puzzle && snapshot.puzzle.present)
    || /\bpuzzle\b/.test(String(snapshot.trackClassName || ''));
  if (!puzzlePresent) return { ...snapshot, kind: 'slide-to-end', ready: true };
  const ready = Boolean(
    snapshot.puzzle
    && snapshot.puzzle.visible
    && snapshot.puzzle.naturalWidth > 0
    && snapshot.puzzle.naturalHeight > 0
  );
  return { ...snapshot, kind: 'puzzle-drag', ready };
}

/**
 * 求拼图块的不透明区域，返回需要拖动的距离。
 *
 * `options.dataUrl`：画布被跨域污染时，由 Node 侧取回图片字节再以 data URL 注入
 * （data URL 同源，画布不会被污染）。
 * `options.boxWidth` / `options.displayWidth`：兜底图不在 DOM 里，尺寸要由调用方给；
 * boxWidth 还用来判断拼图块是不是整幅尺寸 —— 裁剪过的小图推不出缺口位置。
 */
function buildPuzzleOffsetExpression(options = {}) {
  const loadImage = options.dataUrl
    ? `const image = new Image();
       image.src = ${JSON.stringify(String(options.dataUrl))};
       try { await image.decode(); } catch (_error) { return { ok: false, reason: 'image_decode_failed' }; }`
    : `const image = document.querySelector(${JSON.stringify(PUZZLE_SELECTOR)});
       if (!image) return { ok: false, reason: 'puzzle_missing' };
       if (!image.complete || !image.naturalWidth) {
         try { await image.decode(); } catch (_error) { return { ok: false, reason: 'puzzle_not_loaded' }; }
       }`;
  const boxWidthSource = options.boxWidth
    ? `const boxWidth = ${Number(options.boxWidth)};`
    : `const box = document.querySelector(${JSON.stringify(IMAGE_BOX_SELECTOR)});
       const boxWidth = box ? box.getBoundingClientRect().width : 0;`;
  // data URL 兜底时图片不在 DOM 里，getBoundingClientRect 恒为 0，必须由调用方给显示宽度。
  const displayWidthSource = Number(options.displayWidth) > 0
    ? `const displayWidth = ${Number(options.displayWidth)};`
    : `const displayWidth = (typeof image.getBoundingClientRect === 'function' ? image.getBoundingClientRect().width : 0) || 0;`;
  return `(async () => {
    ${loadImage}
    const width = image.naturalWidth || 0;
    const height = image.naturalHeight || 0;
    if (!width || !height) return { ok: false, reason: 'puzzle_not_loaded' };
    ${boxWidthSource}
    ${displayWidthSource}
    // 裁剪过的小图（宽度明显小于背景容器）不能靠 alpha 包围盒推缺口。
    if (boxWidth && displayWidth && displayWidth < boxWidth * 0.8) {
      return { ok: false, reason: 'puzzle_image_cropped', naturalWidth: width, displayWidth, boxWidth };
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return { ok: false, reason: 'canvas_unavailable' };
    context.drawImage(image, 0, 0, width, height);
    let data;
    try {
      data = context.getImageData(0, 0, width, height).data;
    } catch (_error) {
      return { ok: false, reason: 'tainted_canvas', src: String(image.currentSrc || image.src || ''), naturalWidth: width, naturalHeight: height };
    }
    const scan = (threshold) => {
      let minX = width;
      let maxX = -1;
      let minY = height;
      let maxY = -1;
      let count = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (data[(y * width + x) * 4 + 3] < threshold) continue;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          count += 1;
        }
      }
      return count > 0 ? { minX, maxX, minY, maxY, count } : null;
    };
    // 先按实心像素找（阴影/抗锯齿是半透明的，会把包围盒撑大）。
    const piece = scan(200) || scan(24);
    if (!piece) return { ok: false, reason: 'puzzle_empty' };
    const scale = displayWidth > 0 ? displayWidth / width : 1;
    return {
      ok: true,
      naturalWidth: width,
      naturalHeight: height,
      displayWidth,
      boxWidth,
      scale,
      piece,
      offset: Math.round(piece.minX * scale)
    };
  })()`;
}

module.exports = {
  IMAGE_BOX_SELECTOR,
  PUZZLE_SELECTOR,
  WIDGET_PROBE_EXPRESSION,
  buildPuzzleOffsetExpression,
  classifyChallenge
};
