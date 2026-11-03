package upstreamfailure

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"strconv"
	"strings"
	"syscall"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

const (
	// MaxErrorPayloadBytes 是 Observer 允许短暂读取的最大错误正文。
	MaxErrorPayloadBytes = 64 * 1024
	// maxRetryAfterLength 防止异常 Header 进入无界日期或整数解析。
	maxRetryAfterLength = 128
)

var (
	// ErrInvalidObservation 表示 Observer 调用缺少必要的本地输入。
	ErrInvalidObservation = errors.New("上游失败观察输入无效")
	// ErrNoFailureEvidence 表示成功响应中没有结构化失败证据。
	ErrNoFailureEvidence = errors.New("上游响应没有失败证据")
	// ErrErrorPayloadTooLarge 表示错误正文超过固定安全上限。
	ErrErrorPayloadTooLarge = errors.New("上游错误正文超过安全上限")
	// ErrMalformedErrorPayload 表示错误正文不是一个完整 JSON 值。
	ErrMalformedErrorPayload = errors.New("上游错误正文格式无效")
	// ErrErrorPayloadRead 表示读取有界错误正文时发生 I/O 故障。
	ErrErrorPayloadRead = errors.New("读取上游错误正文失败")
)

// SSEInput 是 Provider Observer 所需的最小流事件投影。
//
// Data 只包含 SSE decoder 已经切出的单个 data payload，不包含完整响应流。
type SSEInput struct {
	// EventType 是 SSE event 字段；允许为空并由 JSON type 判断事件。
	EventType string
	// Data 是单个事件的 JSON payload，允许由多个网络分块组成。
	Data io.Reader
	// Header 只由 Observer 按固定白名单读取，不能向领域层透传。
	Header http.Header
	// ObservedAt 是收到响应或事件的确定性业务时间。
	ObservedAt time.Time
}

// ParseRetryAfter 解析 RFC Retry-After 秒数或 HTTP 日期。
//
// 第二个返回值只表示 Header 语法有效；已经到期的合法日期返回零等待和 true。
func ParseRetryAfter(
	value string,
	observedAt time.Time,
) (time.Duration, bool) {
	if !isObservationTime(observedAt) ||
		value == "" ||
		len(value) > maxRetryAfterLength ||
		value != strings.TrimSpace(value) ||
		containsControlCharacter(value) {
		return 0, false
	}
	if isDecimal(value) {
		seconds, err := strconv.ParseUint(value, 10, 64)
		if err != nil ||
			seconds > uint64(math.MaxInt64/int64(time.Second)) {
			return 0, false
		}
		return time.Duration(seconds) * time.Second, true
	}
	retryAt, err := http.ParseTime(value)
	if err != nil {
		return 0, false
	}
	normalizedObservedAt := time.UnixMilli(
		observedAt.UnixMilli(),
	).UTC()
	delay := retryAt.UTC().Sub(normalizedObservedAt)
	if delay <= 0 {
		return 0, true
	}
	return delay, true
}

// DecodeErrorPayload 把单个有界 JSON 错误正文解码到调用方提供的目标值。
//
// 该函数不返回原始字节；Provider Observer 应传入只声明分类字段的私有结构。
func DecodeErrorPayload(reader io.Reader, destination any) error {
	if reader == nil || destination == nil {
		return ErrInvalidObservation
	}
	limited := &io.LimitedReader{
		R: reader,
		N: MaxErrorPayloadBytes + 1,
	}
	payload, err := io.ReadAll(limited)
	if err != nil {
		return ErrErrorPayloadRead
	}
	if len(payload) > MaxErrorPayloadBytes {
		return ErrErrorPayloadTooLarge
	}
	if len(payload) == 0 {
		return ErrMalformedErrorPayload
	}
	if err := json.Unmarshal(payload, destination); err != nil {
		return ErrMalformedErrorPayload
	}
	return nil
}

// NormalizeErrorToken 返回可进入低敏分类值对象的小写稳定标识。
func NormalizeErrorToken(value string) (string, bool) {
	normalized, err := normalizeToken(value)
	if err != nil || normalized == "" {
		return "", false
	}
	return normalized, true
}

// ClassifyTransportError 使用 errors.Is/errors.As 映射 Go 稳定错误身份。
//
// 错误消息不会参与分类，避免 Provider 文本或用户内容改变运行态。
func ClassifyTransportError(err error) (Classification, error) {
	if err == nil {
		return Classification{}, ErrInvalidObservation
	}
	switch {
	case errors.Is(err, context.Canceled):
		return ClassifyTransport(TransportRequestCancelled)
	case errors.Is(err, context.DeadlineExceeded):
		return ClassifyTransport(TransportTimeout)
	case isTimeoutError(err):
		return ClassifyTransport(TransportTimeout)
	case errors.Is(err, syscall.ECONNRESET):
		return ClassifyTransport(TransportConnectionReset)
	default:
		return ClassifyTransport(TransportUnclassified)
	}
}

// ClassifyIncompleteStream 分类缺少 Provider 完成事件的流终止。
//
// 已知取消、超时和连接重置保留具体原因，其余终止归为流中断。
func ClassifyIncompleteStream(err error) (Classification, error) {
	if err == nil ||
		errors.Is(err, io.EOF) ||
		errors.Is(err, io.ErrUnexpectedEOF) {
		return ClassifyTransport(TransportStreamDisconnected)
	}
	classification, classifyErr := ClassifyTransportError(err)
	if classifyErr != nil {
		return Classification{}, classifyErr
	}
	if classification.Kind() == runtimecore.FailureUnclassified {
		return ClassifyTransport(TransportStreamDisconnected)
	}
	return classification, nil
}

// isTimeoutError 判断错误链是否实现稳定的 net.Error 超时合同。
func isTimeoutError(err error) bool {
	var networkError net.Error
	return errors.As(err, &networkError) && networkError.Timeout()
}

// isObservationTime 判断时间能否安全参与 Retry-After 比较。
func isObservationTime(value time.Time) bool {
	return !value.IsZero() &&
		value.Year() >= 1970 &&
		value.Year() <= 9999
}

// containsControlCharacter 拒绝换行和其他不可见 Header 注入字符。
func containsControlCharacter(value string) bool {
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return true
		}
	}
	return false
}

// isDecimal 判断 Retry-After 是否完全由十进制数字组成。
func isDecimal(value string) bool {
	for index := 0; index < len(value); index++ {
		if value[index] < '0' || value[index] > '9' {
			return false
		}
	}
	return value != ""
}
