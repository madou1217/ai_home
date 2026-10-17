package relaycore

import "errors"

// errNotArray 是内部 JSON 解析哨兵（decodeRawArray 用）。
var errNotArray = errors.New("不是数组")

// 透传通道的公开错误。具体 Provider 与调用方按这些哨兵判断该交还 Canonical 还是报错。

// ErrInvalidDependencies 表示 Handler 缺少任一必需端口。
var ErrInvalidDependencies = errors.New("透传通道依赖无效")

// ErrUnsupportedCredential 表示账号凭据不是该 Provider 的原生登录态（取不到鉴权令牌）。
//
// 调用方应据此把请求交回 Canonical：那边尊重账号自带的 Base URL 等差异，
// 透传只承诺承载「官方端点 + 原生凭据」这一种形态。
var ErrUnsupportedCredential = errors.New("透传凭据不受支持")

// ErrInvalidRequestBody 表示请求体不是合法 JSON 对象，或本通道表达不了。
//
// 调用方应据此交回 Canonical 入口：那边会按客户端协议给出规范的 400，而不是由透传通道
// 拼一个自造错误——透传只承诺处理它真正理解的请求。
var ErrInvalidRequestBody = errors.New("透传请求体无效")
