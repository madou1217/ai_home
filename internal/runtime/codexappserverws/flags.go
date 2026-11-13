// Package codexappserverws 提供 Codex app-server WebSocket 网关代理所需的运行时能力：
// JSON-RPC 请求重写、thread/resume 响应补丁、子进程环境构建与进程组生命周期管理。
package codexappserverws

import (
	"net/url"
	"strings"
)

const (
	// CodexFlagsEnv 是合并传递 Codex 启动与代理开关的环境变量名。
	CodexFlagsEnv = "AIH_CODEX_FLAGS"
)

// codexFlagsFieldOrder 与 lib/runtime/codex-flags.js 中的 FIELD_ORDER 保持严格一致。
var codexFlagsFieldOrder = []string{
	"authPreflight",
	"autoSkipRepoCheck",
	"disableRemoteResume",
	"tuiLocalRemote",
	"remoteProxy",
	"managedLaunch",
	"hooks",
	"routeOwner",
	"upstreamProtocol",
}

// ParseCodexFlags 解析 AIH_CODEX_FLAGS 中的逗号分隔键值对，语义与 JS decodeURIComponent 一致。
func ParseCodexFlags(raw string) map[string]string {
	fields := make(map[string]string)
	for _, part := range strings.Split(raw, ",") {
		key, rawVal, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		rawVal = strings.TrimSpace(rawVal)
		if key == "" || rawVal == "" {
			continue
		}
		if decoded, err := url.PathUnescape(rawVal); err == nil {
			fields[key] = decoded
		} else {
			fields[key] = rawVal
		}
	}
	return fields
}

// SerializeCodexFlags 按契约字段顺序序列化 AIH_CODEX_FLAGS。
func SerializeCodexFlags(fields map[string]string) string {
	if len(fields) == 0 {
		return ""
	}
	parts := make([]string, 0, len(codexFlagsFieldOrder))
	for _, key := range codexFlagsFieldOrder {
		val := fields[key]
		if val == "" {
			continue
		}
		parts = append(parts, key+"="+encodeURIComponentCompat(val))
	}
	return strings.Join(parts, ",")
}

// SetCodexFlag 更新单个字符串形式的 AIH_CODEX_FLAGS 值并按契约顺序重新序列化。
func SetCodexFlag(current string, key string, value string) string {
	cleanKey := strings.TrimSpace(key)
	cleanVal := strings.TrimSpace(value)
	if cleanKey == "" || cleanVal == "" {
		return current
	}
	fields := ParseCodexFlags(current)
	fields[cleanKey] = cleanVal
	return SerializeCodexFlags(fields)
}

// ReadCodexFlagFromEnv 从环境映射中读取指定标志位。
func ReadCodexFlagFromEnv(env map[string]string, key string) string {
	if len(env) == 0 || key == "" {
		return ""
	}
	fields := ParseCodexFlags(env[CodexFlagsEnv])
	return fields[key]
}

// SetCodexFlagInEnv 在环境映射中写入指定标志位并按契约顺序序列化 AIH_CODEX_FLAGS。
func SetCodexFlagInEnv(env map[string]string, key string, value string) {
	if env == nil || key == "" || value == "" {
		return
	}
	fields := ParseCodexFlags(env[CodexFlagsEnv])
	fields[key] = value
	if serialized := SerializeCodexFlags(fields); serialized != "" {
		env[CodexFlagsEnv] = serialized
	}
}

// ClearCodexFlagInEnv 从环境映射中移除指定标志位；若结果为空则删除 AIH_CODEX_FLAGS。
func ClearCodexFlagInEnv(env map[string]string, key string) {
	if env == nil || key == "" {
		return
	}
	fields := ParseCodexFlags(env[CodexFlagsEnv])
	delete(fields, key)
	if serialized := SerializeCodexFlags(fields); serialized != "" {
		env[CodexFlagsEnv] = serialized
	} else {
		delete(env, CodexFlagsEnv)
	}
}

// ConsumeCodexManagedLaunch 消费一次性 managedLaunch=1 托管启动标记。
// 命中时清除 managedLaunch（若无其余标志则删除 AIH_CODEX_FLAGS）并返回 true。
func ConsumeCodexManagedLaunch(env map[string]string) bool {
	if len(env) == 0 {
		return false
	}
	if ReadCodexFlagFromEnv(env, "managedLaunch") != "1" {
		return false
	}
	ClearCodexFlagInEnv(env, "managedLaunch")
	return true
}

func encodeURIComponentCompat(value string) string {
	// url.QueryEscape 将空格编码为 '+'，替换为 "%20" 以对齐 JS encodeURIComponent。
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
}
