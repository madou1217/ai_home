// Package upstreamfailure 提供 Provider 错误分类器共享的低敏值对象。
//
// 该包不解析响应正文，也不决定 Codex 或 Claude 的业务语义。
package upstreamfailure

import (
	"errors"
	"strings"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

const (
	// maxTokenLength 限制错误标识长度，避免误传上游正文或用户内容。
	maxTokenLength = 80
)

var (
	// ErrInvalidResponseInput 表示响应分类输入包含非法状态、正文或等待时间。
	ErrInvalidResponseInput = errors.New("上游失败响应分类输入无效")
	// ErrInvalidClassification 表示分类结果不能形成合法的运行态事件。
	ErrInvalidClassification = errors.New("上游失败分类结果无效")
	// ErrUnknownTransportKind 表示传输层提交了未注册的稳定事件。
	ErrUnknownTransportKind = errors.New("上游传输失败类型未知")
)

// TransportKind 是不依赖 Provider 响应格式的稳定传输失败类型。
type TransportKind string

const (
	// TransportTimeout 表示请求在传输层超时。
	TransportTimeout TransportKind = "timeout"
	// TransportConnectionReset 表示连接被对端或网络重置。
	TransportConnectionReset TransportKind = "connection_reset"
	// TransportStreamDisconnected 表示流在完成事件前断开。
	TransportStreamDisconnected TransportKind = "stream_disconnected"
	// TransportRequestCancelled 表示调用方主动取消请求。
	TransportRequestCancelled TransportKind = "request_cancelled"
	// TransportUnclassified 表示没有足够证据进一步分类。
	TransportUnclassified TransportKind = "unclassified"
)

// ResponseInput 是 HTTP、SDK 或 SSE observer 提交的低敏响应投影。
//
// ErrorType 与 ErrorCode 只能包含稳定标识，不能传入 message 或响应正文。
type ResponseInput struct {
	// StatusCode 是 HTTP 状态；流内错误允许使用 200。
	StatusCode int
	// ErrorType 是 Provider 给出的稳定错误类型标识。
	ErrorType string
	// ErrorCode 是 Provider 给出的稳定错误代码标识。
	ErrorCode string
	// RetryAfter 是上游给出的有限恢复等待提示。
	RetryAfter time.Duration
}

// Response 是完成校验和规范化后的不可变响应投影。
type Response struct {
	statusCode int
	errorType  string
	errorCode  string
	retryAfter time.Duration
}

// NormalizeResponseInput 校验低敏边界并把稳定标识统一为小写。
func NormalizeResponseInput(input ResponseInput) (Response, error) {
	errorType, err := normalizeToken(input.ErrorType)
	if err != nil {
		return Response{}, ErrInvalidResponseInput
	}
	errorCode, err := normalizeToken(input.ErrorCode)
	if err != nil {
		return Response{}, ErrInvalidResponseInput
	}
	if input.StatusCode < 200 ||
		input.StatusCode > 599 ||
		input.RetryAfter < 0 ||
		input.RetryAfter%time.Millisecond != 0 {
		return Response{}, ErrInvalidResponseInput
	}
	return Response{
		statusCode: input.StatusCode,
		errorType:  errorType,
		errorCode:  errorCode,
		retryAfter: input.RetryAfter,
	}, nil
}

// StatusCode 返回 HTTP 状态；SSE 流内错误允许保留成功状态 200。
func (response Response) StatusCode() int {
	return response.statusCode
}

// ErrorType 返回小写规范化后的 Provider 错误类型。
func (response Response) ErrorType() string {
	return response.errorType
}

// ErrorCode 返回小写规范化后的 Provider 错误代码。
func (response Response) ErrorCode() string {
	return response.errorCode
}

// RetryAfter 返回 Provider 给出的恢复等待提示。
func (response Response) RetryAfter() time.Duration {
	return response.retryAfter
}

// Classification 是 Provider 语义映射后的不可变运行态分类。
type Classification struct {
	kind           runtimecore.FailureKind
	retryAfter     time.Duration
	blockDirective runtimecore.BlockDirective
}

// NewClassification 创建不能绕过领域 cooldown 上限的分类结果。
func NewClassification(
	kind runtimecore.FailureKind,
	retryAfter time.Duration,
) (Classification, error) {
	policy, err := runtimecore.PolicyFor(kind)
	if err != nil {
		return Classification{}, ErrInvalidClassification
	}
	var directive runtimecore.BlockDirective
	if policy.BlocksRouting() {
		directive, err = runtimecore.DefaultBlockDirective(kind)
		if err != nil {
			return Classification{}, ErrInvalidClassification
		}
	}
	return newClassification(kind, retryAfter, directive)
}

// NewBlockingClassification 创建带 Provider 明确作用域的硬阻塞分类。
func NewBlockingClassification(
	kind runtimecore.FailureKind,
	scope runtimecore.BlockScope,
) (Classification, error) {
	directive, err := runtimecore.NewBlockDirective(kind, scope)
	if err != nil {
		return Classification{}, ErrInvalidClassification
	}
	return newClassification(kind, 0, directive)
}

// newClassification 统一校验 cooldown 提示与硬阻塞指令互斥。
func newClassification(
	kind runtimecore.FailureKind,
	retryAfter time.Duration,
	directive runtimecore.BlockDirective,
) (Classification, error) {
	policy, err := runtimecore.PolicyFor(kind)
	if err != nil ||
		retryAfter < 0 ||
		retryAfter > runtimecore.MaxCooldownHint ||
		retryAfter%time.Millisecond != 0 ||
		retryAfter > 0 && !policy.EntersCooldown() ||
		!validBlockDirective(policy, kind, directive) {
		return Classification{}, ErrInvalidClassification
	}
	return Classification{
		kind:           kind,
		retryAfter:     retryAfter,
		blockDirective: directive,
	}, nil
}

// ClassifyTransport 把稳定传输事件映射为统一运行态失败类型。
func ClassifyTransport(kind TransportKind) (Classification, error) {
	var failureKind runtimecore.FailureKind
	switch kind {
	case TransportTimeout:
		failureKind = runtimecore.FailureRequestTimeout
	case TransportConnectionReset:
		failureKind = runtimecore.FailureConnectionReset
	case TransportStreamDisconnected:
		failureKind = runtimecore.FailureStreamDisconnected
	case TransportRequestCancelled:
		failureKind = runtimecore.FailureRequestCancelled
	case TransportUnclassified:
		failureKind = runtimecore.FailureUnclassified
	default:
		return Classification{}, ErrUnknownTransportKind
	}
	return NewClassification(failureKind, 0)
}

// Kind 返回运行态核心识别的稳定失败类型。
func (classification Classification) Kind() runtimecore.FailureKind {
	return classification.kind
}

// RetryAfter 返回不超过领域上限的有限恢复提示。
func (classification Classification) RetryAfter() time.Duration {
	return classification.retryAfter
}

// BlockDirective 返回硬阻塞作用域和解除信号；非阻塞分类返回零值。
func (classification Classification) BlockDirective() runtimecore.BlockDirective {
	return classification.blockDirective
}

// IsValid 判断分类是否能安全提交给运行态 Registry。
func (classification Classification) IsValid() bool {
	_, err := newClassification(
		classification.kind,
		classification.retryAfter,
		classification.blockDirective,
	)
	return err == nil
}

// validBlockDirective 验证硬阻塞必须带指令，其他动作必须保持零值。
func validBlockDirective(
	policy runtimecore.FailurePolicy,
	kind runtimecore.FailureKind,
	directive runtimecore.BlockDirective,
) bool {
	if policy.BlocksRouting() {
		return directive.IsValidFor(kind)
	}
	return directive.IsZero()
}

// normalizeToken 校验稳定标识并拒绝空格、换行和原始错误正文。
func normalizeToken(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	if len(value) > maxTokenLength {
		return "", ErrInvalidResponseInput
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		if isTokenCharacter(character) {
			continue
		}
		return "", ErrInvalidResponseInput
	}
	return strings.ToLower(value), nil
}

// isTokenCharacter 判断字符是否属于稳定错误标识的 ASCII 白名单。
func isTokenCharacter(character byte) bool {
	return character >= 'a' && character <= 'z' ||
		character >= 'A' && character <= 'Z' ||
		character >= '0' && character <= '9' ||
		character == '_' ||
		character == '-' ||
		character == '.'
}
