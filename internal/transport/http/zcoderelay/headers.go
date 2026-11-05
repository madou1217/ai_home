// Package zcoderelay 实现 zcode 的 Anthropic Messages 原生透传通道。
//
// 迁移自 Node 的 `zcode-inference-headers` + `zcode-harness-request` + 通用透传，
// 但**不是逐行照抄**：Node 那份把「身份头 / harness 整形成 / 设备事实读取 / 传输」
// 混在同一个大函数里，Go 拆成三个可独立测试的端口：
//
//   - headers.go  纯函数：把 ZCode 客户端身份头补进上游请求（不读文件、不联网）；
//   - harness.go  纯函数：把请求体的 system 整形成官方 harness 形态（下一步迁）；
//   - provider.go relaycore.Provider：只负责解析账号端点与签名/装配。
//
// 宿主事实（device mid、官方 harness 文本、OS 版本）由调用方以参数传入，
// 传输层不认识本机文件布局。
package zcoderelay

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// 官方客户端在 plan 端点上的固定画像（2026-10-28 抓包逐字）。
const (
	// CLIUserAgentSuffix 是官方客户端 UA 的 ai-sdk 后缀。
	CLIUserAgentSuffix = "ai-sdk/provider-utils/4.0.27 runtime/node.js/22"
	// CLITitle 是 plan 端点请求的 X-Title。
	CLITitle = "Z Code@electron"
	// CLIReleaseChannel 是官方客户端的发布通道（production，不是 stable）。
	CLIReleaseChannel = "production"
	// AnthropicBeta 是官方模型请求固定携带的 beta。
	AnthropicBeta = "mid-conversation-system-2026-04-07"
	// IdentityAgent 是 X-ZCode-Agent 的固定值。
	IdentityAgent = "glm"
)

// HeaderInput 是补身份头所需的事实。零值可用，缺项会按 Node 侧同样的 fail-soft 跳过。
type HeaderInput struct {
	// AppVersion 是 ZCode 客户端版本；为空时不写版本相关头。
	AppVersion string
	// DeviceMid 是设备 mid（官方客户端安装时生成，属于账号运行目录）。
	DeviceMid string
	// OSVersion 是 os.release() 的等价事实；为空时不写。
	OSVersion string
	// SessionKey 是 aih 的会话键；不是 UUID 时由这里派生稳定 UUID。
	SessionKey string
	// Base 是宿主已解析的客户端元数据头（键名大小写不敏感）。
	Base map[string]string
	// Random 是 UUID 的熵源，nil 时用 crypto/rand。
	Random io.Reader
	// Now 提供 UUIDv7 的时间前缀，nil 时用 time.Now。
	Now func() time.Time
}

// ApplyIdentityHeaders 就地把 ZCode 客户端身份头补进 headers。
//
// 语义与 Node 侧一致：
//   - 客户端/上游已经给出的同名头**不覆盖**（除下列强制项）；
//   - X-Title / X-Release-Channel / UA 强制覆盖：plan 端点服务的是 CLI 形态请求，
//     而宿主元数据默认是 Electron 形态；
//   - 任何失败都 fail-soft（生成不了 UUID 就跳过该头），不能让请求失败。
func ApplyIdentityHeaders(headers http.Header, input HeaderInput) http.Header {
	if headers == nil {
		return headers
	}
	random := input.Random
	if random == nil {
		random = rand.Reader
	}
	now := input.Now
	if now == nil {
		now = time.Now
	}
	appVersion := strings.TrimSpace(input.AppVersion)
	deviceMid := strings.TrimSpace(input.DeviceMid)

	setIfAbsent := func(name, value string) {
		if strings.TrimSpace(headers.Get(name)) != "" {
			return
		}
		if text := strings.TrimSpace(value); text != "" {
			headers.Set(name, text)
		}
	}
	setAlways := func(name, value string) {
		if text := strings.TrimSpace(value); text != "" {
			headers.Set(name, text)
		}
	}

	for name, value := range input.Base {
		setIfAbsent(name, value)
	}
	if appVersion != "" {
		setAlways("X-ZCode-App-Version", appVersion)
		setAlways("User-Agent", "ZCode/"+appVersion+" "+CLIUserAgentSuffix)
	}
	if deviceMid != "" {
		setAlways("X-Device-Mid", deviceMid)
	}
	setAlways("X-Title", CLITitle)
	setAlways("X-Release-Channel", CLIReleaseChannel)
	setAlways("X-ZCode-Agent", IdentityAgent)
	setAlways("x-zcode-query-source", "main_turn")
	setAlways("x-zcode-session-type", "main")
	if osVersion := strings.TrimSpace(input.OSVersion); osVersion != "" {
		setAlways("X-Os-Version", osVersion)
	}
	setIfAbsent("anthropic-beta", AnthropicBeta)
	if queryID, err := NewUUIDv7(random, now()); err == nil {
		setIfAbsent("x-query-id", queryID)
	}
	if requestID, err := NewUUIDv4(random); err == nil {
		setIfAbsent("x-request-id", requestID)
	}
	if traceID, err := NewUUIDv4(random); err == nil {
		setIfAbsent("x-zcode-trace-id", traceID)
	}
	if sessionID := ResolveSessionID(input.SessionKey, deviceMid, random); sessionID != "" {
		setAlways("x-session-id", sessionID)
		setAlways("X-Session-Id", sessionID)
	}
	return headers
}

// ResolveSessionID 返回上游可接受的裸 UUID。
//
// 官方客户端按 x-session-id 做会话/缓存亲和，因此 aih 的会话键不是 UUID 时不能直接
// 透传，而是派生一个**稳定** UUID（同一会话每次相同）。与 Node 侧算法逐字节一致。
func ResolveSessionID(sessionKey, deviceMid string, random io.Reader) string {
	raw := strings.TrimSpace(sessionKey)
	if isUUID(raw) {
		return strings.ToLower(raw)
	}
	seed := raw
	if seed == "" {
		seed = strings.TrimSpace(deviceMid)
	}
	if seed == "" {
		id, err := NewUUIDv4(random)
		if err != nil {
			return ""
		}
		return id
	}
	hash := sha256.Sum256([]byte("zcode-session\x00" + seed))
	hexed := hex.EncodeToString(hash[:])
	return fmt.Sprintf("%s-%s-4%s-8%s-%s",
		hexed[0:8],
		hexed[8:12],
		hexed[13:16],
		hexed[17:20],
		hexed[20:32],
	)
}

// NewUUIDv4 生成随机 UUID；random 为 nil 时用 crypto/rand。
func NewUUIDv4(random io.Reader) (string, error) {
	if random == nil {
		random = rand.Reader
	}
	var bytes [16]byte
	if _, err := io.ReadFull(random, bytes[:]); err != nil {
		return "", err
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return formatUUID(bytes), nil
}

// NewUUIDv7 生成带时间前缀的 UUIDv7（官方 x-query-id 形态）。
func NewUUIDv7(random io.Reader, now time.Time) (string, error) {
	if random == nil {
		random = rand.Reader
	}
	var bytes [16]byte
	if _, err := io.ReadFull(random, bytes[:]); err != nil {
		return "", err
	}
	millis := now.UnixMilli()
	for index := 0; index < 6; index++ {
		bytes[index] = byte(millis >> (8 * (5 - index)))
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x70
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return formatUUID(bytes), nil
}

func formatUUID(bytes [16]byte) string {
	hexed := hex.EncodeToString(bytes[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hexed[0:8],
		hexed[8:12],
		hexed[12:16],
		hexed[16:20],
		hexed[20:32],
	)
}

func isUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, character := range value {
		switch index {
		case 8, 13, 18, 23:
			if character != '-' {
				return false
			}
		default:
			if !((character >= '0' && character <= '9') ||
				(character >= 'a' && character <= 'f') ||
				(character >= 'A' && character <= 'F')) {
				return false
			}
		}
	}
	return true
}
