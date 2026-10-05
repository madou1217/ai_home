package pluginapi

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/madou1217/ai_home/application/accountrouting"
	appplugins "github.com/madou1217/ai_home/application/pluginruntime"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

// GenerationHeader 是 Node 公开入口给内部转发打上的插件代次。
//
// 只有带内部客户端密钥的请求才信任它；闸门读取后立即删除，不向下游传播。
// 公开客户端不能直接访问 Go，Node 的转发器也会剥掉客户端自带的同名头。
const GenerationHeader = "X-Aih-Plugin-Generation"

// RequestGate 在推理入口（选号、协议解码之前）运行 gateway.request，语义与 Node v1-router 一致。
//
// 没有代次头时零开销直通（不读正文）。代次投影不存在（例如 Go 刚重启、Node 尚未重新推送）
// 或正文被压缩时，按「解码拒收」交回 Node：此时还没有任何副作用，Node 用它缓冲的原文重新处理。
type RequestGate struct {
	registry   *appplugins.Registry
	invoker    appplugins.Invoker
	authorizer Authorizer
	maxBody    int64
	observer   *appplugins.Observer
}

// NewRequestGate 创建入口闸门；observer 为 nil 时不投递观察事件。
func NewRequestGate(registry *appplugins.Registry, invoker appplugins.Invoker, authorizer Authorizer, maxBody int64, observer *appplugins.Observer) (*RequestGate, error) {
	if registry == nil || invoker == nil || authorizer == nil || maxBody <= 0 {
		return nil, ErrInvalidDependencies
	}
	return &RequestGate{registry: registry, invoker: invoker, authorizer: authorizer, maxBody: maxBody, observer: observer}, nil
}

// Wrap 返回带闸门的入口；protocol 是该入口的客户端协议名（与 Node detectClientProtocol 一致）。
func (gate *RequestGate) Wrap(protocol string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		raw := request.Header.Get(GenerationHeader)
		request.Header.Del(GenerationHeader)
		if raw == "" || !gate.authorizer.Authorized(request) || isUpgrade(request) || request.Method != http.MethodPost {
			next.ServeHTTP(response, request)
			return
		}
		generation, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || generation <= 0 {
			next.ServeHTTP(response, request)
			return
		}
		projection, ok := gate.registry.Get(generation)
		if !ok {
			handBack(response, "plugin_generation_unavailable")
			return
		}
		observing := projection.Has(appplugins.CapabilityObserve) && gate.observer != nil
		preferring := projection.Has(appplugins.CapabilityGatewayAccount) && gate.observer != nil
		if !projection.Has(appplugins.CapabilityGatewayRequest) && !observing && !preferring {
			next.ServeHTTP(response, request)
			return
		}
		if observing || preferring {
			var committed func() bool
			if observing {
				// 只在有观察插件时包装 ResponseWriter（记录失败时响应头是否已写出）。
				tracker := &commitTracker{ResponseWriter: response}
				response = tracker
				committed = tracker.Committed
			}
			pin := appplugins.NewPin(generation, projection, gate.observer, time.Now(), committed)
			ctx := appplugins.WithPin(request.Context(), pin)
			if preferring {
				// gateway.account：选号器在首次选号前向它要偏好顺序（见 application/accountrouting/preference.go）。
				ctx = accountrouting.WithPreferenceProvider(ctx, pin)
			}
			request = request.WithContext(ctx)
		}
		if !projection.Has(appplugins.CapabilityGatewayRequest) {
			next.ServeHTTP(response, request)
			return
		}
		if encoding := strings.TrimSpace(request.Header.Get("Content-Encoding")); encoding != "" && !strings.EqualFold(encoding, "identity") {
			handBack(response, "plugin_compressed_body")
			return
		}
		body, err := io.ReadAll(io.LimitReader(request.Body, gate.maxBody+1))
		_ = request.Body.Close()
		if err != nil || int64(len(body)) > gate.maxBody {
			// Node 已缓冲原文并按自己的上限处理，交还而不是在 Go 侧拒绝。
			handBack(response, "plugin_body_too_large")
			return
		}
		trimmed := bytes.TrimSpace(body)
		if len(trimmed) == 0 || trimmed[0] != '{' {
			restoreBody(request, body)
			next.ServeHTTP(response, request)
			return
		}
		outcome, err := appplugins.RunRequestStage(request.Context(), gate.invoker, projection, appplugins.RequestInput{
			Protocol: protocol,
			Path:     request.URL.Path,
			Body:     body,
		})
		if err != nil {
			code := "plugin_failed"
			var stageErr *appplugins.StageError
			if errors.As(err, &stageErr) && stageErr.Code != "" {
				code = stageErr.Code
			}
			// 连不上 Plugin Host 不是插件失败：交还 Node（它能连上同一个宿主），不让请求以 502 结束。
			if code == appplugins.CodeHostUnavailable {
				handBack(response, code)
				return
			}
			writeError(response, http.StatusBadGateway, code, err.Error())
			return
		}
		if outcome.Reject != nil {
			writeError(response, outcome.Reject.Status, "plugin_rejected", outcome.Reject.Message)
			return
		}
		restoreBody(request, outcome.Body)
		next.ServeHTTP(response, request)
	})
}

// commitTracker 记录响应头是否已写出；保留 Flush（SSE 逐帧下发）与 Unwrap（http.ResponseController）。
type commitTracker struct {
	http.ResponseWriter
	committed atomic.Bool
}

func (tracker *commitTracker) WriteHeader(status int) {
	tracker.committed.Store(true)
	tracker.ResponseWriter.WriteHeader(status)
}

func (tracker *commitTracker) Write(data []byte) (int, error) {
	tracker.committed.Store(true)
	return tracker.ResponseWriter.Write(data)
}

func (tracker *commitTracker) Flush() {
	if flusher, ok := tracker.ResponseWriter.(http.Flusher); ok {
		tracker.committed.Store(true)
		flusher.Flush()
	}
}

func (tracker *commitTracker) Unwrap() http.ResponseWriter { return tracker.ResponseWriter }

// Committed 报告响应头是否已经写给客户端。
func (tracker *commitTracker) Committed() bool { return tracker.committed.Load() }

func restoreBody(request *http.Request, body []byte) {
	request.Body = io.NopCloser(bytes.NewReader(body))
	request.ContentLength = int64(len(body))
	request.Header.Set("Content-Length", strconv.Itoa(len(body)))
}

func isUpgrade(request *http.Request) bool {
	return strings.EqualFold(request.Header.Get("Upgrade"), "websocket")
}

// handBack 让 Node 用它缓冲的原文重新处理同一请求（还没有任何副作用）。
func handBack(response http.ResponseWriter, code string) {
	inferenceapi.MarkDecodeRejected(response)
	writeError(response, http.StatusBadRequest, code, "插件代次需由 Node 处理")
}
