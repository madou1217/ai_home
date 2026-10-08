// Package codeassist 实现 Antigravity Code Assist agent 线协议。
package codeassist

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/core/inference"
	agyfailure "github.com/madou1217/ai_home/internal/adapters/agy/upstreamfailure"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	sharedsse "github.com/madou1217/ai_home/internal/adapters/sse"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

var ErrInvalidDependencies = errors.New("AGY Code Assist Adapter 依赖无效")

type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

type Clock func() time.Time

// Adapter 持有 Code Assist 传输依赖与只读的账号模型转发表。
type Adapter struct {
	client HTTPClient
	clock  Clock
	random io.Reader
	wires  ModelWireReader
}

var _ inferencegateway.UpstreamAdapter = (*Adapter)(nil)

func NewAdapter(client HTTPClient, clock Clock) (*Adapter, error) {
	return NewAdapterWithWireModels(client, clock, nil)
}

func NewAdapterWithWireModels(client HTTPClient, clock Clock, wires ModelWireReader) (*Adapter, error) {
	if client == nil || clock == nil {
		return nil, ErrInvalidDependencies
	}
	return &Adapter{client: client, clock: clock, random: rand.Reader, wires: wires}, nil
}

func (*Adapter) ProtocolID() inference.ProtocolID {
	return inference.ProtocolAgyCodeAssist
}

func (*Adapter) SupportsCredential(credential accountapp.Credential) bool {
	_, valid := credential.(*agy.OAuthAuth)
	return valid
}

func (adapter *Adapter) Execute(
	ctx context.Context,
	invocation inferencegateway.Invocation,
	emit inferencegateway.EventSink,
) (inferencegateway.AttemptResult, error) {
	auth, valid := invocation.Credential().(*agy.OAuthAuth)
	if adapter == nil || adapter.client == nil || adapter.clock == nil ||
		ctx == nil || emit == nil || !valid || auth == nil ||
		invocation.Route().ProviderID() != inference.ProviderAgy ||
		invocation.Route().ProtocolID() != inference.ProtocolAgyCodeAssist {
		return inferencegateway.AttemptResult{}, ErrInvalidDependencies
	}
	if err := ctx.Err(); err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	project, err := loadProject(ctx, adapter.client, auth)
	if err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	requestID, sessionID, err := newRequestIdentities(adapter.clock(), adapter.random)
	if err != nil {
		return inferencegateway.AttemptResult{}, ErrInvalidDependencies
	}
	// 征召、冷却与记账使用公开模型 ID；只在 AGY 线协议边界应用该账号的转发表。
	model := invocation.Route().EffectiveModel()
	wireModel := model
	if adapter.wires != nil {
		credentialRef, identityErr := accountcore.DeriveAccountRef(auth)
		if identityErr != nil {
			return inferencegateway.AttemptResult{}, ErrInvalidDependencies
		}
		wireModel = adapter.wires.Resolve(credentialRef, model)
	}
	payload, err := encodeRequest(
		invocation.Request(),
		wireModel,
		project,
		sessionID,
		requestID,
	)
	if err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		defaultBaseURL+":streamGenerateContent?alt=sse",
		bytes.NewReader(payload),
	)
	if err != nil {
		return inferencegateway.AttemptResult{}, ErrInvalidDependencies
	}
	applyHeaders(request, auth, isClaudeModel(wireModel))
	response, err := adapter.client.Do(request)
	if err != nil {
		failure, classifyErr := attemptfailure.NewTransport(err)
		if classifyErr != nil {
			return inferencegateway.AttemptResult{}, ErrInvalidUpstreamResponse
		}
		return inferencegateway.FailedAttempt(failure), nil
	}
	if response == nil || response.Body == nil {
		return malformedAttempt()
	}
	defer response.Body.Close()
	observedAt := adapter.clock()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return classifyHTTPFailure(response, observedAt)
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "text/event-stream" {
		return malformedAttempt()
	}
	names, err := newToolNameMapper(invocation.Request())
	if err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	decoder := newResponseDecoder(invocation.Route().EffectiveModel(), emit, names)
	reader, err := sharedsse.NewReader(response.Body)
	if err != nil {
		return malformedAttempt()
	}
	for {
		event, readErr := reader.Next()
		if readErr != nil {
			if errors.Is(readErr, io.EOF) && decoder.Terminal() {
				return inferencegateway.CompletedAttempt(), nil
			}
			failure, classifyErr := attemptfailure.NewIncompleteStream(readErr)
			if classifyErr != nil {
				return malformedAttempt()
			}
			return inferencegateway.FailedAttempt(failure), nil
		}
		if bytes.Equal(bytes.TrimSpace(event.Data()), []byte("[DONE]")) {
			if decoder.Terminal() {
				return inferencegateway.CompletedAttempt(), nil
			}
			return malformedAttempt()
		}
		if err := decoder.Apply(event.Data()); err != nil {
			return malformedAttempt()
		}
		if decoder.Terminal() {
			return inferencegateway.CompletedAttempt(), nil
		}
	}
}

func newRequestIdentities(now time.Time, random io.Reader) (string, string, error) {
	if random == nil {
		return "", "", ErrInvalidDependencies
	}
	raw := make([]byte, 20)
	if _, err := io.ReadFull(random, raw); err != nil {
		return "", "", ErrInvalidDependencies
	}
	raw[10] = (raw[10] & 0x0f) | 0x40
	raw[12] = (raw[12] & 0x3f) | 0x80
	requestID := "agent/" + strconv.FormatInt(now.UTC().UnixMilli(), 10) + "/" +
		hex.EncodeToString(raw[:4])
	uuid := hex.EncodeToString(raw[4:])
	sessionID := uuid[:8] + "-" + uuid[8:12] + "-" + uuid[12:16] + "-" +
		uuid[16:20] + "-" + uuid[20:]
	return requestID, sessionID, nil
}

func isClaudeModel(model string) bool {
	return strings.Contains(strings.ToLower(model), "claude")
}

func classifyHTTPFailure(
	response *http.Response,
	observedAt time.Time,
) (inferencegateway.AttemptResult, error) {
	var envelope struct {
		Error struct {
			Code   json.RawMessage `json:"code"`
			Status string          `json:"status"`
		} `json:"error"`
	}
	if err := sharedfailure.DecodeErrorPayload(response.Body, &envelope); err != nil {
		return malformedAttempt()
	}
	code := ""
	if len(envelope.Error.Code) > 0 {
		var number json.Number
		if json.Unmarshal(envelope.Error.Code, &number) == nil {
			code = number.String()
		} else {
			_ = json.Unmarshal(envelope.Error.Code, &code)
		}
	}
	retryAfter, _ := sharedfailure.ParseRetryAfter(
		response.Header.Get("Retry-After"),
		observedAt,
	)
	classification, deferred, err := agyfailure.Classify(agyfailure.Input{
		StatusCode: response.StatusCode,
		Status:     envelope.Error.Status,
		Code:       code,
		RetryAfter: retryAfter,
	})
	if err != nil {
		return malformedAttempt()
	}
	failure, err := newAgyAttemptFailure(classification, deferred)
	if err != nil {
		return malformedAttempt()
	}
	return inferencegateway.FailedAttempt(failure), nil
}

func newAgyAttemptFailure(
	classification sharedfailure.Classification,
	deferred bool,
) (inferencegateway.AttemptFailure, error) {
	policy, err := runtimecore.PolicyFor(classification.Kind())
	if err != nil {
		return inferencegateway.AttemptFailure{}, err
	}
	responseFailure, err := inference.NewResponseFailure(
		string(classification.Kind()),
		attemptfailure.SafeMessage(classification.Kind()),
		policy.Action() != runtimecore.ActionNoStateChange,
	)
	if err != nil {
		return inferencegateway.AttemptFailure{}, err
	}
	return inferencegateway.NewAttemptFailure(inferencegateway.AttemptFailureInput{
		ResponseFailure:                        responseFailure,
		RuntimeKind:                            classification.Kind(),
		RetryAfter:                             classification.RetryAfter(),
		BlockDirective:                         classification.BlockDirective(),
		DeferAccountFailureUntilRequestOutcome: deferred,
	})
}

func malformedAttempt() (inferencegateway.AttemptResult, error) {
	failure, err := attemptfailure.NewClassified(runtimecore.FailureMalformedResponse)
	if err != nil {
		return inferencegateway.AttemptResult{}, ErrInvalidUpstreamResponse
	}
	return inferencegateway.FailedAttempt(failure), nil
}
