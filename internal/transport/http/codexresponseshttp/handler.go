package codexresponseshttp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/contracts/codex-relay"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	"github.com/madou1217/ai_home/internal/adapters/codex/responses"
	codexfailure "github.com/madou1217/ai_home/internal/adapters/codex/upstreamfailure"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

var ErrNotNativeRoute = errors.New("native Responses route requires canonical conversion")

type Selection struct {
	AccountRef  accountcore.AccountRef
	Credential  accountapp.Credential
	Observation accountcredentials.CredentialObservation
}

type Cursor interface {
	Next(context.Context) (Selection, bool, error)
}
type AccountSource interface {
	Open(context.Context, string) (Cursor, error)
}
type Authorizer interface{ Authorized(*http.Request) bool }
type Upstream interface {
	RoundTripNative(context.Context, accountapp.Credential, []byte, http.Header, string) (*http.Response, error)
}

type Dependencies struct {
	Authorizer     Authorizer
	Accounts       AccountSource
	Upstream       Upstream
	Fallback       http.Handler
	Attempts       inferencegateway.AttemptRecorder
	Credentials    inferencegateway.CredentialObservationVerifier
	ModelRefreshes inferencegateway.ModelRefreshScheduler
	Clock          func() time.Time
	// FailureLog 可选：请求以失败结束时收到一份低敏摘要（见 FailureReport）。
	FailureLog func(FailureReport)
}

type Handler struct {
	Dependencies
	observed *inferencegateway.ObservedAttemptRecorder
}

func NewHandler(deps Dependencies) (*Handler, error) {
	if deps.Authorizer == nil || deps.Accounts == nil || deps.Upstream == nil || deps.Fallback == nil || deps.Clock == nil || deps.ModelRefreshes == nil {
		return nil, errors.New("native Responses dependencies are invalid")
	}
	observed, err := inferencegateway.NewObservedAttemptRecorder(deps.Attempts, deps.Credentials)
	if err != nil {
		return nil, err
	}
	return &Handler{Dependencies: deps, observed: observed}, nil
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if !handler.Authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, "unauthorized")
		return
	}
	if len(request.Header.Values(responses.NativeHopHeader)) != 0 {
		writeError(response, "infinite_loop_detected")
		return
	}
	mediaType, _, _ := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if request.Method != http.MethodPost || request.URL.RawQuery != "" || mediaType != "application/json" {
		handler.Fallback.ServeHTTP(response, request)
		return
	}
	ctx, err := inferenceapi.ContextWithPinnedAccount(request)
	if err != nil {
		writeError(response, "invalid_account_ref")
		return
	}
	payload, metadata, err := readRequest(request)
	if err != nil {
		writeError(response, "invalid_request_body")
		return
	}
	trail := handler.newFailureTrail(metadata.Model)
	cursor, err := handler.Accounts.Open(ctx, metadata.Model)
	if errors.Is(err, ErrNotNativeRoute) {
		request.Body = io.NopCloser(bytes.NewReader(payload))
		handler.Fallback.ServeHTTP(response, request.WithContext(ctx))
		return
	}
	if err != nil || cursor == nil {
		handler.fail(response, trail, "no_available_account")
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	var last *http.Response
	var lastRef accountcore.AccountRef
	contacted := false
	defer func() {
		if last != nil {
			_ = last.Body.Close()
		}
	}()
	for attempt := 0; attempt < 4; attempt++ {
		selection, found, err := cursor.Next(ctx)
		if err != nil || !found || ctx.Err() != nil {
			break
		}
		route, err := runtimecore.NewModelRoute(selection.AccountRef, metadata.Model)
		if err != nil || selection.Credential == nil || selection.Credential.ProviderID() != "codex" || !selection.Observation.IsValid() || selection.Observation.AccountRef() != selection.AccountRef || selection.Observation.ProviderID() != "codex" {
			break
		}
		// ChatGPT 登录账号的上游只接受 codex CLI 形状的请求（见 nativeRequest.passthroughSafe）。
		// 尚未联系上游时按「解码拒收」交回 Node 归一化（Go Canonical 编码器会直接拒收 store 等字段，
		// 不能落到 Fallback）；已有账号试过就跳过这个账号，不把注定 400 的请求发出去。
		if isStatelessCredential(selection.Credential) && !metadata.passthroughSafe() {
			if !contacted {
				inferenceapi.MarkDecodeRejected(response)
				writeError(response, "invalid_request_body")
				return
			}
			continue
		}
		contacted = true
		attemptStarted := trail.now()
		upstream, err := handler.Upstream.RoundTripNative(ctx, selection.Credential, payload, request.Header, request.Host)
		if err != nil || upstream == nil || upstream.Body == nil {
			if upstream != nil && upstream.Body != nil {
				_ = upstream.Body.Close()
			}
			if request.Context().Err() != nil {
				return
			}
			if err == nil {
				err = io.ErrUnexpectedEOF
			}
			failure, classifyErr := attemptfailure.NewTransport(err)
			if classifyErr == nil {
				handler.recordFailure(ctx, route, selection, failure)
			}
			trail.attempt(selection.AccountRef, "transport", failure, err.Error(), attemptStarted)
			continue
		}
		if last != nil {
			_ = last.Body.Close()
			last = nil
		}
		if upstream.StatusCode >= 200 && upstream.StatusCode < 300 {
			failure := handler.probeResponse(upstream, metadata.Stream)
			if request.Context().Err() != nil {
				_ = upstream.Body.Close()
				return
			}
			if failure.IsValid() && failure.RuntimeKind() == runtimecore.FailureSafetyRejected {
				handler.recordFailure(ctx, route, selection, failure)
				_ = upstream.Body.Close()
				trail.attempt(selection.AccountRef, "safety_rejected", failure, "", attemptStarted)
				handler.fail(response, trail, "upstream_safety_rejected")
				return
			}
			handler.deliver(response, request.WithContext(ctx), upstream, route, selection, metadata.Stream)
			_ = upstream.Body.Close()
			return
		}
		prefix, readErr := io.ReadAll(io.LimitReader(upstream.Body, 1024*1024+1))
		observedResponse := *upstream
		observedResponse.Body = io.NopCloser(bytes.NewReader(prefix))
		classification, classifyErr := codexfailure.ObserveHTTP(&observedResponse, handler.Clock())
		failure, failureErr := attemptfailure.New(classification)
		retry := false
		trail.attempt(selection.AccountRef, fmt.Sprintf("http_%d", upstream.StatusCode), failure, "", attemptStarted)
		if classifyErr == nil && failureErr == nil {
			handler.recordFailure(ctx, route, selection, failure)
			if failure.RuntimeKind() == runtimecore.FailureSafetyRejected {
				_ = upstream.Body.Close()
				handler.fail(response, trail, "upstream_safety_rejected")
				return
			}
			retry = failure.ResponseFailure().Retryable()
		}
		if readErr != nil || len(prefix) > 1024*1024 || !retry {
			copyHeaders(response.Header(), upstream.Header)
			setAccountHeaders(response, selection.AccountRef)
			response.WriteHeader(upstream.StatusCode)
			copyBody(response, io.MultiReader(bytes.NewReader(prefix), upstream.Body))
			_ = upstream.Body.Close()
			trail.finish(upstream.StatusCode, "upstream_status")
			return
		}
		_ = upstream.Body.Close()
		upstream.Body = io.NopCloser(bytes.NewReader(prefix))
		last, lastRef = upstream, selection.AccountRef
	}
	if request.Context().Err() != nil {
		return
	}
	if last != nil {
		copyHeaders(response.Header(), last.Header)
		setAccountHeaders(response, lastRef)
		response.WriteHeader(last.StatusCode)
		copyBody(response, last.Body)
		trail.finish(last.StatusCode, "upstream_status")
		return
	}
	if !contacted {
		handler.fail(response, trail, "no_available_account")
		return
	}
	handler.fail(response, trail, "upstream_temporarily_unavailable")
}

// fail 写出网关错误并汇报失败摘要。
func (handler *Handler) fail(response http.ResponseWriter, trail *failureTrail, code string) {
	writeError(response, code)
	trail.finish(codexrelay.Error(code).Status, code)
}

func (handler *Handler) recordFailure(ctx context.Context, route runtimecore.ModelRoute, selection Selection, failure inferencegateway.AttemptFailure) {
	recorded, _ := handler.observed.RecordFailure(ctx, route, selection.Observation, failure)
	if recorded && failure.RuntimeKind() == runtimecore.FailureModelUnsupported {
		_ = handler.ModelRefreshes.ScheduleModelRefresh(ctx, selection.AccountRef, "codex")
	}
}

func writeError(response http.ResponseWriter, code string) {
	definition := codexrelay.Error(code)
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(definition.Status)
	_ = json.NewEncoder(response).Encode(map[string]any{"error": map[string]any{"code": code, "message": definition.Message, "type": definition.Type, "param": nil}})
}

// isStatelessCredential 报告凭据是否指向不存储 response 的 ChatGPT Codex 上游。
func isStatelessCredential(credential accountapp.Credential) bool {
	_, oauth := credential.(*codexauth.OAuthAuth)
	return oauth
}
