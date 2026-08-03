// Package inferencehttp 装配统一 Canonical Executor 的三个推理 HTTP 协议入口。
package inferencehttp

import (
	"errors"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/anthropicmessages"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/openaichatcompletions"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/openairesponses"
	"github.com/madou1217/ai_home/internal/transport/http/anthropicmessagesapi"
	"github.com/madou1217/ai_home/internal/transport/http/openaichatcompletionsapi"
	"github.com/madou1217/ai_home/internal/transport/http/openairesponsesapi"
)

// ErrInvalidDependencies 表示推理 HTTP 组合模块缺少必要端口。
var ErrInvalidDependencies = errors.New("推理 HTTP 组合模块依赖无效")

// Authorizer 是三个公开推理协议共用的客户端鉴权策略。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 声明推理 HTTP 组合模块的最小依赖。
type Dependencies struct {
	// Executor 是三个协议共享的 Canonical 推理执行端口。
	Executor inferencegateway.Executor
	// Authorizer 隔离标准客户端权限域，不接受管理密钥。
	Authorizer Authorizer
	// Clock 为 OpenAI 响应生成稳定创建时间。
	Clock func() time.Time
	// MessagesDecodeErrorObserver 接收不含字段值的 Anthropic Decoder 诊断。
	MessagesDecodeErrorObserver func(error)
	// MaxBodyBytes 为零时由各协议 Handler 使用安全默认值。
	MaxBodyBytes int64
}

// New 创建精确注册 Responses、Chat Completions 和 Messages 的 HTTP Handler。
func New(dependencies Dependencies) (http.Handler, error) {
	if dependencies.Executor == nil ||
		dependencies.Authorizer == nil ||
		dependencies.Clock == nil {
		return nil, ErrInvalidDependencies
	}
	protocols, err := newProtocolRegistry(dependencies.Clock)
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	responses, err := openairesponsesapi.NewHandler(
		openairesponsesapi.Dependencies{
			Protocols:    protocols,
			Executor:     dependencies.Executor,
			Authorizer:   dependencies.Authorizer,
			MaxBodyBytes: dependencies.MaxBodyBytes,
		},
	)
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	chat, err := openaichatcompletionsapi.NewHandler(
		openaichatcompletionsapi.Dependencies{
			Protocols:    protocols,
			Executor:     dependencies.Executor,
			Authorizer:   dependencies.Authorizer,
			MaxBodyBytes: dependencies.MaxBodyBytes,
		},
	)
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	messages, err := anthropicmessagesapi.NewHandler(
		anthropicmessagesapi.Dependencies{
			Protocols:           protocols,
			Executor:            dependencies.Executor,
			Authorizer:          dependencies.Authorizer,
			DecodeErrorObserver: dependencies.MessagesDecodeErrorObserver,
			MaxBodyBytes:        dependencies.MaxBodyBytes,
		},
	)
	if err != nil {
		return nil, ErrInvalidDependencies
	}

	router := http.NewServeMux()
	router.Handle(openairesponsesapi.Path, responses)
	router.Handle(openaichatcompletionsapi.Path, chat)
	router.Handle(anthropicmessagesapi.Path, messages)
	return router, nil
}

// newProtocolRegistry 创建只读且可并发共享的客户端协议策略注册表。
func newProtocolRegistry(clock func() time.Time) (*clientprotocol.Registry, error) {
	responses, err := openairesponses.NewAdapter(clock)
	if err != nil {
		return nil, err
	}
	chat, err := openaichatcompletions.NewAdapter(clock)
	if err != nil {
		return nil, err
	}
	return clientprotocol.NewRegistry(
		responses,
		chat,
		anthropicmessages.NewAdapter(),
	)
}
