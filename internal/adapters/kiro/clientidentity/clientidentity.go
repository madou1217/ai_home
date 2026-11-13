// Package clientidentity 提供 kiro 上游要求的客户端标识。
//
// 2026-11-13 在 AWS 服务器上用真实账号实测（5 个 Builder ID / 社交登录账号）：
//   - 不带 Kiro 版本的请求会被上游拒绝：Go 默认 UA 回 403，aws-sdk-js UA 回
//     400 UnsupportedClientVersionException；
//   - 同一 token、同一请求体，只补上 "aws-sdk-js/<sdk> Kiro/<version>" 就回 200，
//     响应是正常的 AWS event-stream。
//
// 上游当前只校验「请求里带 Kiro 版本」这一件事（0.5.0–2.5.0 实测都放行），
// 但版本字符串仍然集中在这里：以后上游抬高门槛只改这一处，推理与模型发现
// 必须同时带着它，否则会出现「聊天 403、目录能拉到」这种半通状态。
package clientidentity

const (
	// SDKVersion 是 AWS SDK for JavaScript 的版本号（真实客户端用它拼 UA）。
	SDKVersion = "3.620.0"
	// Version 是上报给上游的 Kiro 客户端版本。
	Version = "0.9.0"
	// UserAgent 是推理与模型发现共用的客户端标识。
	UserAgent = "aws-sdk-js/" + SDKVersion + " Kiro/" + Version
)
