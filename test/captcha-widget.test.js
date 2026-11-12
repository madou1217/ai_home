'use strict';

// 阿里云拖拽控件识别层的回归守卫。
//
// 2026-11-05 用户真机遇到「拖拽验证码」：无痕验证没直接放行时，SDK 渲染滑轨，
// 可能是「拖到最右边」，也可能是「拖动拼图块到缺口」。两类挑战的 DOM 差异只有
// 一个 #aliyunCaptcha-puzzle，判错就会把拼图当滑块拖到底，必然失败。
//
// 这些 id 是从线上动态 JS（captcha-frontend/dynamicJS/3.29.0）里取证的契约，
// 不是猜的：改成别的选择器会静默失效，所以在这里钉死。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WIDGET_PROBE_EXPRESSION,
  buildPuzzleOffsetExpression,
  classifyChallenge
} = require('../lib/captcha/aliyun');

test('控件探测用 id 契约，不依赖会被改的类名', () => {
  for (const id of [
    '#aliyunCaptcha-sliding-slider',
    '#aliyunCaptcha-sliding-body',
    '#aliyunCaptcha-puzzle',
    '#aliyunCaptcha-img-box',
    '#aliyunCaptcha-sliding-text',
    '#aliyunCaptcha-question'
  ]) {
    assert.ok(WIDGET_PROBE_EXPRESSION.includes(id), `探测表达式缺少 ${id}`);
  }
  assert.ok(WIDGET_PROBE_EXPRESSION.includes('__aihCaptchaOutcome'), '必须同时读 SDK 回调结果');
});

test('没有滑轨时不算挑战（无痕验证收合态）', () => {
  assert.equal(classifyChallenge(null), null);
  assert.equal(classifyChallenge({ slider: null, track: null }), null);
  assert.equal(
    classifyChallenge({ slider: null, track: null, question: '' }),
    null,
    '收合态只有「点击开始验证」，不能当成挑战'
  );
});

test('只有滑轨、没有拼图 → 拖到最右边', () => {
  const challenge = classifyChallenge({
    slider: { x: 80, y: 400, width: 40, height: 40 },
    track: { x: 80, y: 400, width: 300, height: 40 },
    trackClassName: '',
    puzzle: null
  });
  assert.equal(challenge.kind, 'slide-to-end');
  assert.equal(challenge.ready, true);
});

test('滑轨 + 拼图 → 拼图拖拽', () => {
  const challenge = classifyChallenge({
    slider: { x: 80, y: 400, width: 40, height: 40 },
    track: { x: 80, y: 400, width: 300, height: 40 },
    trackClassName: 'puzzle',
    puzzle: {
      present: true,
      visible: true,
      rect: { x: 80, y: 180, width: 300, height: 200 },
      naturalWidth: 300,
      naturalHeight: 200
    }
  });
  assert.equal(challenge.kind, 'puzzle-drag');
  assert.equal(challenge.ready, true);
});

test('拼图图还没加载完时不能退化成「拖到最右边」', () => {
  // 这是最容易写错的一处：图片是异步加载的，naturalWidth=0 的那一瞬间
  // 如果按「没有拼图」处理，就会把把手一路拖到底，白白浪费一次验证。
  const challenge = classifyChallenge({
    slider: { x: 80, y: 400, width: 40, height: 40 },
    track: { x: 80, y: 400, width: 300, height: 40 },
    trackClassName: 'puzzle',
    puzzle: { present: true, visible: true, rect: null, naturalWidth: 0, naturalHeight: 0 }
  });
  assert.equal(challenge.kind, 'puzzle-drag');
  assert.equal(challenge.ready, false, '没加载完只能等，不能换解算方式');
});

test('文字点选只识别、不冒充滑块', () => {
  const challenge = classifyChallenge({
    slider: null,
    track: null,
    question: '请依次点击「天」「地」'
  });
  assert.equal(challenge.kind, 'text-click');
});

test('缺口偏移表达式按 alpha 包围盒取，先找实心像素', () => {
  const expression = buildPuzzleOffsetExpression();
  assert.ok(expression.includes('#aliyunCaptcha-puzzle'), '必须读拼图块本身');
  assert.ok(expression.includes('getImageData'), '必须在页面内读像素');
  assert.ok(expression.includes('scan(200) || scan(24)'), '阴影/抗锯齿会把包围盒撑大，优先用实心像素');
  assert.ok(expression.includes('puzzle_image_cropped'), '裁剪过的小图必须明确报错，不能瞎猜');
  assert.ok(expression.includes('tainted_canvas'), '跨域污染要能识别，交给上层用 data URL 重试');
});

test('data URL 兜底表达式不再读 DOM 图片', () => {
  const expression = buildPuzzleOffsetExpression({
    dataUrl: 'data:image/png;base64,AAAA',
    boxWidth: 300,
    displayWidth: 300
  });
  assert.ok(expression.includes('data:image/png;base64,AAAA'));
  assert.ok(expression.includes('const boxWidth = 300;'));
  assert.ok(expression.includes('const displayWidth = 300;'), '兜底图不在 DOM 里，显示宽度必须由调用方给');
  assert.equal(expression.includes('document.querySelector("#aliyunCaptcha-puzzle")'), false);
});
