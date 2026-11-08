package inferencehttp

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
)

const (
	// modelProbeBytes 是提取 model 字段时读取的请求体前缀上限。
	//
	// 推理请求的完整请求体仍由各协议 Handler 读取；这里只做一次前缀探测，
	// 避免为了一个字段把 32MB 图片请求在内存里复制两份。
	modelProbeBytes = 128 * 1024
	// routeOwnerHeader 与 Node 的协议常量一致：强制宿主本地处理。
	//
	// 前门把模型交还 Node 时如果不带这个标记，Node 会按条目（例如
	// gateway.openai.chat_completions）再次转回 Go，形成回调环。
	routeOwnerHeader = "x-aih-route-owner"
	routeOwnerNode   = "node"
)

// modelFieldPattern 是前缀被截断时的宽松兜底：标准 JSON 解析失败后只找 model 字段。
var modelFieldPattern = regexp.MustCompile(`"model"\s*:\s*"([^"\\]+)"`)

// ModelCatalog 判断 Go 的推理目录是否知道某个模型。
type ModelCatalog interface {
	HasModel(model string) bool
}

// modelFallback 把「Go 目录里不存在的模型」原样交还宿主（Node）。
//
// 为什么需要：前门切到 Go 后，Node 不再是公开入口，无法再替 Go 接住
// gemini / 自定义账号这类只有 Node 能路由的模型；少了这一层，这些请求会
// 直接变成 503。
type modelFallback struct {
	catalog  ModelCatalog
	upstream http.Handler
}

// newModelFallback 构造前缀探测式回落中间件；依赖不完整时返回 nil，调用方保持原链路。
func newModelFallback(catalog ModelCatalog, upstream http.Handler) *modelFallback {
	if catalog == nil || upstream == nil {
		return nil
	}
	return &modelFallback{catalog: catalog, upstream: upstream}
}

// wrap 让 next 先处理；只有目录里完全没有该模型时才改走宿主。
func (fallback *modelFallback) wrap(next http.Handler) http.Handler {
	if fallback == nil || next == nil {
		return next
	}
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request == nil || request.Method != http.MethodPost || request.Body == nil {
			next.ServeHTTP(response, request)
			return
		}
		// 没带凭据的请求不探测请求体：鉴权在各自的 Handler 里，先读 128KB 会让
		// 未认证流量产生不必要的工作量。
		if strings.TrimSpace(request.Header.Get("Authorization")) == "" {
			next.ServeHTTP(response, request)
			return
		}

		model := probeRequestModel(request)
		if model == "" || fallback.catalog.HasModel(model) {
			next.ServeHTTP(response, request)
			return
		}
		// 交还宿主：标记 route-owner=node，Node 的网关转发器据此本地处理，
		// 不会再按条目把请求转回 Go。
		request.Header.Set(routeOwnerHeader, routeOwnerNode)
		fallback.upstream.ServeHTTP(response, request)
	})
}

// probeRequestModel 从路径（Gemini）或 JSON 前缀（其余协议）提取模型名，并回填请求体。
//
// 返回空串表示「这次探测拿不到模型」：调用方必须原样放行，由协议 Handler
// 自己给出权威错误，不能把畸形请求直接丢给宿主。
func probeRequestModel(request *http.Request) string {
	if model := modelFromPath(request.URL.Path); model != "" {
		return model
	}
	if !isJSONContentType(request.Header.Get("Content-Type")) {
		return ""
	}
	original := request.Body
	prefix, err := io.ReadAll(io.LimitReader(original, modelProbeBytes))
	// 无论探测结果如何都要把已读字节放回请求体，否则后续 Handler 会少一段输入。
	request.Body = &replayedBody{
		Reader: io.MultiReader(bytes.NewReader(prefix), original),
		Closer: original,
	}
	if err != nil || len(prefix) == 0 {
		return ""
	}
	return modelFromJSON(prefix)
}

// replayedBody 把前缀与原始流拼回一个可关闭的请求体。
type replayedBody struct {
	io.Reader
	io.Closer
}

// modelFromPath 解析 Gemini 的 /v1{beta?}/models/{model}:generateContent 形态。
func modelFromPath(path string) string {
	const marker = "/models/"
	index := strings.LastIndex(path, marker)
	if index < 0 {
		return ""
	}
	rest := path[index+len(marker):]
	colon := strings.IndexByte(rest, ':')
	if colon <= 0 {
		return ""
	}
	return strings.TrimSpace(rest[:colon])
}

// modelFromJSON 先按完整 JSON 解析；前缀被截断时退到单字段扫描。
func modelFromJSON(prefix []byte) string {
	var envelope struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(prefix, &envelope); err == nil {
		return strings.TrimSpace(envelope.Model)
	}
	match := modelFieldPattern.FindSubmatch(prefix)
	if len(match) < 2 {
		return ""
	}
	return strings.TrimSpace(string(match[1]))
}

// isJSONContentType 只接受 application/json（可带参数），与协议 Handler 同口径。
func isJSONContentType(value string) bool {
	mediaType := strings.TrimSpace(strings.Split(value, ";")[0])
	return strings.EqualFold(mediaType, "application/json")
}
