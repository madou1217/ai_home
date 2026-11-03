'use strict';

// Go 重启窗口里转发器手上可能还是旧端口：连接被拒时 Go 一个字节都没收到。
// 这类「连接根本没建立」的错误下，已缓冲请求体的请求可以原样交还 Node 处理——这不是重放。
// 连接建立之后的错误（ECONNRESET、socket hang up 等）Go 可能已经开始处理，仍按失败关闭。
const NOT_CONNECTED_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'EADDRNOTAVAIL', 'EHOSTUNREACH', 'ENETUNREACH']);

function goNeverReceivedRequest(error) {
  return Boolean(error && NOT_CONNECTED_CODES.has(error.code));
}

module.exports = { goNeverReceivedRequest };
