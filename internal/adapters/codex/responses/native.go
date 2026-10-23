package responses

import (
	"bytes"
	"context"
	"net/http"
	"strconv"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/internal/adapters/codex/codexidentity"
)

const NativeHopHeader = "X-Aih-Codex-Relay-Hop"

// MaxNativeRelayHops 是一次推理允许经过的**网关**跳数上限（与 Node 侧
// lib/server/codex-relay-hop.js 的 MAX_CODEX_RELAY_HOPS 逐字一致）。
//
// 该头记录「本请求已被几台 aih 网关转发过」：客户端直连本网关时没有它（0 跳），
// 网关把请求转给对端网关时写 1。历史上这里把「头存在」直接当成自环并 508，于是
// 「本机 aih → 远程 server 上的 aih」这种**跨机中转**永远打不通 —— 对端一律回
// `Gateway proxy loop detected`，WebUI 会话表现为
// `stream disconnected before completion`。要防的是 A→B→A 的无限环，不是一跳中转。
// 与 fabric 反向网关同一套设计：lib/server/fabric-gateway-protocol.js 的
// MAX_FABRIC_GATEWAY_HOPS��
const MaxNativeRelayHops = 1

// NativeRelayHop 解析请求已走过的网关跳数；缺失/非法一律按 0（未中转）。
func NativeRelayHop(header http.Header) int {
	raw := strings.TrimSpace(header.Get(NativeHopHeader))
	if raw == "" {
		return 0
	}
	hop, err := strconv.Atoi(raw)
	if err != nil || hop < 0 {
		return 0
	}
	return hop
}

func (adapter *Adapter) RoundTripNative(ctx context.Context, credential accountapp.Credential, payload []byte, header http.Header, localAuthority string) (*http.Response, error) {
	auth, err := projectAuth(credential)
	if err != nil || adapter == nil || adapter.client == nil {
		return nil, ErrInvalidInvocation
	}
	endpoint, err := responsesEndpoint(auth.baseURL)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil || request.URL.User != nil || (request.URL.Scheme != "https" && request.URL.Scheme != "http") || strings.EqualFold(request.URL.Host, localAuthority) {
		return nil, ErrInvalidInvocation
	}
	auth.clientVersion = adapter.versions.Current()
	if err := applyAuthenticationHeaders(request, auth); err != nil {
		return nil, err
	}
	if identity, ok := codexidentity.ClientHeaders(header); ok {
		request.Header.Del("Version")
		for name, values := range identity {
			request.Header[name] = values
		}
	}
	for _, name := range []string{"Content-Type", "Content-Encoding", "Accept", "OpenAI-Beta", "X-Client-Request-Id", "Session-Id", "Thread-Id", "X-Codex-Routing-Hint", "Traceparent", "Tracestate"} {
		if value, ok := codexidentity.SingleSafeHeader(header, name); ok {
			request.Header.Set(name, value)
		}
	}
	// 递增而不是写死 1：对端据此判断这条链还���不能再往下转（见 MaxNativeRelayHops）。
	request.Header.Set(NativeHopHeader, strconv.Itoa(NativeRelayHop(header)+1))
	return adapter.client.Do(request)
}
