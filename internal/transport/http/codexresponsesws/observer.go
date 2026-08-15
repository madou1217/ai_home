package codexresponsesws

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	codexfailure "github.com/madou1217/ai_home/internal/adapters/codex/upstreamfailure"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

var (
	// ErrInvalidObserverState 表示上游终态与当前串行请求状态不一致。
	ErrInvalidObserverState = errors.New("Codex Responses WebSocket 观察状态无效")
)

// turnObserver 只观察请求是否在途、是否预热和上游终态，不保存帧正文。
type turnObserver struct {
	mu             sync.Mutex
	model          string
	route          runtimecore.ModelRoute
	observation    accountcredentials.CredentialObservation
	attempts       *inferencegateway.ObservedAttemptRecorder
	modelRefreshes inferencegateway.ModelRefreshScheduler
	clock          func() time.Time
	active         bool
	generate       bool
}

// newTurnObserver 创建连接级串行状态机。
func newTurnObserver(
	model string,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	attempts *inferencegateway.ObservedAttemptRecorder,
	modelRefreshes inferencegateway.ModelRefreshScheduler,
	clock func() time.Time,
) *turnObserver {
	return &turnObserver{
		model:          model,
		route:          route,
		observation:    observation,
		attempts:       attempts,
		modelRefreshes: modelRefreshes,
		clock:          clock,
	}
}

// Begin 校验后续每轮仍使用同一模型，并拒绝同连接并行请求。
func (observer *turnObserver) Begin(payload []byte) error {
	request, err := parseClientFrame(payload)
	if err != nil || observer == nil || request.Model != observer.model {
		return ErrInvalidClientFrame
	}
	observer.mu.Lock()
	defer observer.mu.Unlock()
	if observer.active {
		return ErrConcurrentTurn
	}
	observer.active = true
	observer.generate = request.Generate == nil || *request.Generate
	return nil
}

// ObserveUpstream 在终态转发给客户端前提交低敏运行态，并返回是否应结束
// 当前 WebSocket 连接。Codex 官方实现把 response.failed、response.incomplete
// 和 error 都视为当前响应流的终态；只有 response.completed 可以复用连接。
func (observer *turnObserver) ObserveUpstream(payload []byte) (bool, error) {
	if observer == nil || observer.attempts == nil ||
		!observer.observation.IsValid() ||
		observer.modelRefreshes == nil || observer.clock == nil {
		return false, ErrInvalidObserverState
	}
	var event struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(payload, &event) != nil || event.Type == "" {
		// 未知未来事件仍原样透传；只有明确终态才影响状态机。
		return false, nil
	}
	switch event.Type {
	case "response.completed":
		generate, err := observer.finishTurn()
		if err != nil {
			return false, err
		}
		if !generate {
			return false, nil
		}
		success, successErr := inferencegateway.NewAttemptSuccess(observer.clock())
		if successErr != nil {
			return false, ErrInvalidObserverState
		}
		_, successErr = observer.attempts.RecordSuccess(
			context.Background(),
			observer.route,
			observer.observation,
			success,
		)
		return false, successErr
	case "response.failed", "error":
		generate, err := observer.finishTurn()
		if err != nil {
			// 连接级 error 可以出现在两轮之间，例如 60 分钟连接寿命结束；
			// 它没有可归属的账号请求，但仍必须结束这条上游连接。
			if event.Type != "error" {
				return true, err
			}
			return true, nil
		}
		if !generate {
			return true, nil
		}
		classification, observed, err := codexfailure.ObserveWebSocket(
			sharedfailure.SSEInput{
				EventType:  event.Type,
				Data:       bytes.NewReader(payload),
				ObservedAt: observer.clock(),
			},
		)
		if err != nil || !observed {
			return true, ErrInvalidObserverState
		}
		failure, err := attemptfailure.New(classification)
		if err != nil {
			return true, ErrInvalidObserverState
		}
		if err := recordCodexFailure(
			context.Background(),
			observer.attempts,
			observer.modelRefreshes,
			observer.route,
			observer.observation,
			failure,
		); err != nil {
			return true, err
		}
		return true, nil
	case "response.incomplete":
		_, err := observer.finishTurn()
		return true, err
	default:
		return false, nil
	}
}

// RecordMalformedUpstream 提交明确的二进制业务帧协议错误，不进入 cooldown。
func (observer *turnObserver) RecordMalformedUpstream() error {
	if observer == nil {
		return ErrInvalidObserverState
	}
	generate, err := observer.finishTurn()
	if err != nil || !generate {
		return err
	}
	failure, err := attemptfailure.NewClassified(
		runtimecore.FailureMalformedResponse,
	)
	if err != nil {
		return ErrInvalidObserverState
	}
	return recordCodexFailure(
		context.Background(),
		observer.attempts,
		observer.modelRefreshes,
		observer.route,
		observer.observation,
		failure,
	)
}

// recordCodexFailure 统一保护 WS 握手、转发与终态观察产生的运行态写入。
func recordCodexFailure(
	ctx context.Context,
	attempts *inferencegateway.ObservedAttemptRecorder,
	modelRefreshes inferencegateway.ModelRefreshScheduler,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	failure inferencegateway.AttemptFailure,
) error {
	if attempts == nil || modelRefreshes == nil {
		return ErrInvalidObserverState
	}
	recorded, err := attempts.RecordFailure(ctx, route, observation, failure)
	if err != nil || !recorded {
		return err
	}
	if failure.RuntimeKind() == runtimecore.FailureModelUnsupported {
		_ = modelRefreshes.ScheduleModelRefresh(
			ctx,
			route.AccountRef(),
			"codex",
		)
	}
	return nil
}

// ActiveGenerating 判断连接断开时是否存在应归属到账号的真实生成请求。
func (observer *turnObserver) ActiveGenerating() bool {
	if observer == nil {
		return false
	}
	observer.mu.Lock()
	defer observer.mu.Unlock()
	return observer.active && observer.generate
}

// Route 返回当前连接固定使用的账号模型运行态键。
func (observer *turnObserver) Route() runtimecore.ModelRoute {
	if observer == nil {
		return runtimecore.ModelRoute{}
	}
	return observer.route
}

// CredentialObservation 返回当前连接建连时读取的低敏凭据观察。
func (observer *turnObserver) CredentialObservation() accountcredentials.CredentialObservation {
	if observer == nil {
		return accountcredentials.CredentialObservation{}
	}
	return observer.observation
}

// finishTurn 原子清除当前轮，并返回它是否是真实生成请求。
func (observer *turnObserver) finishTurn() (bool, error) {
	observer.mu.Lock()
	defer observer.mu.Unlock()
	if !observer.active {
		return false, ErrInvalidObserverState
	}
	generate := observer.generate
	observer.active = false
	observer.generate = false
	return generate, nil
}
