'use strict';

// 文本附件里内嵌的 base64 data URI（典型是 HTML 的 <img src="data:image/webp;base64,…">）
// 对模型是纯噪声:它看不见 base64 文本里的图像,这些字节却按 token 计费并吃满窗口。
//
// 实测（会话 session-809bb12b… / agy gemini-3.8-flash-high,窗口 1,048,576）:
// 一个 2,789,035 字符的 HTML 附件里 40 个 data URI 占 2,009,764 字符 = 72.1%,
// 整体粗估 ~877K tokens,上游以 `input token count exceeds ... 1048576` 拒绝。
// 剥离载荷后剩 779,271 字符 ≈ 207K tokens,是该附件唯一能装进窗口的形态。
//
// 只替换 base64 载荷,保留 `data:<mime>;base64,` 前缀与它所在的属性结构,
// 因此 HTML 骨架、样式与文案逐字保留,模型仍然知道"这里有一张什么类型、多大的图"。

// 每个重复段必须以 `;` 起头,与载荷字符集不相交,不存在指数回溯。
// 载荷刻意不含 \s:base64 可能跨行折行,但把空白纳入字符集会让
// `…base64,QQ==\n\n  Hello` 把正文 Hello 一起吞掉——宁可少剥一点,不可损坏原文。
const DATA_URI = /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)((?:;[a-zA-Z0-9.+=-]+)*);base64,([A-Za-z0-9+/=]+)/g;

// 小载荷多为图标/掩码,占位符自身也有长度,剥离收益低于它带来的结构噪声。
const MIN_ELIDED_PAYLOAD_CHARS = 256;

function elideDataUris(text, options = {}) {
  const source = text === undefined || text === null ? '' : String(text);
  const minPayload = Number.isSafeInteger(options.minPayloadChars) && options.minPayloadChars >= 0
    ? options.minPayloadChars
    : MIN_ELIDED_PAYLOAD_CHARS;
  let count = 0;
  let savedChars = 0;
  const elided = source.replace(DATA_URI, (match, mime, params, payload) => {
    if (payload.length < minPayload) return match;
    count += 1;
    const placeholder = `data:${mime}${params};base64,[AIH-ELIDED-${count}:${payload.length}chars]`;
    savedChars += match.length - placeholder.length;
    return placeholder;
  });
  return count === 0
    ? { text: source, count: 0, savedChars: 0 }
    : { text: elided, count, savedChars };
}

// 如实披露:模型必须知道自己拿到的不是逐字节原文,否则它会以为图片内容已在手上。
function elisionNotice(count, savedChars) {
  if (count <= 0) return '';
  return `（本附件含 ${count} 处内嵌 base64 资源,合计 ${savedChars} 字符,`
    + '已替换为占位符以适配上下文窗口;HTML 结构、样式与文案逐字保留,'
    + '仅图片/媒体的二进制载荷不可见。）';
}

module.exports = { DATA_URI, MIN_ELIDED_PAYLOAD_CHARS, elideDataUris, elisionNotice };
