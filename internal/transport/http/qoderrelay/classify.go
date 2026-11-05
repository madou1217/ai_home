// 本文件负责 qoder 的业务失败判定与交付形态。
//
// 上游排队（{\"code\":\"10605\",\"isQueued\":true,\"retryAfterSeconds\":30}）是 qoder
// 最常见的拒绝方式，它藏在 200 响应的 SSE 首帧里。如果不在记账前识别，账号会被记成
// 健康、客户端则挂在「等首个 token」上直到超时——这正是 Node 宿主修过、Go 侧必须
// 同样处理的路径。
package qoderrelay

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

const (
	// queueFailureCode 是排队交付给客户端的错误码（对齐 Node 侧）。
	queueFailureCode = "qoder_resource_limit"
	// queueIndicatorHeader 让客户端/日志能区分「排队」与普通限流。
	queueIndicatorHeader = "x-aih-qoder-queue"
	// defaultQueueRetrySeconds 是上游没说等多久时的兜底提示（对齐 Node 的 30s）。
	defaultQueueRetrySeconds = 30
	// queueLayerDepth 限制嵌套 JSON 字符串的展开层数（实测三层）。
	queueLayerDepth = 4
)

var (
	queueRetryAfterPattern = regexp.MustCompile(`"retryafterseconds"\s*:\s*(\d+)`)
	queueWaitTimePattern   = regexp.MustCompile(`"waittime"\s*:\s*(\d+)`)
	queueTypePattern       = regexp.MustCompile(`"queuetype"\s*:\s*"([^"]+)"`)
	queueFlagPattern       = regexp.MustCompile(`"isqueued"\s*:\s*true`)
)

// QueueInfo 是上游排队负载里的可交付信息。
type QueueInfo struct {
	RetryAfterSeconds int
	QueueType         string
	WaitTime          int
}

// DetectQueue 判断一段负载是否表达「上游正在排队」，并取出重试提示。
//
// 为什么不能只解析一层：qoder 的限流负载实测套了三层 JSON 字符串
// （外层 code/message → 中间 10605/message → 真正的 isQueued/retryAfterSeconds）。
// 这里与 Node 的 qoderQueueInfo 同口径：逐层展开后一起匹配。
func DetectQueue(payload []byte) (QueueInfo, bool) {
	text := queueText(payload)
	if !strings.Contains(text, "10605") &&
		!strings.Contains(text, "resource_limit") &&
		!queueFlagPattern.MatchString(text) {
		return QueueInfo{}, false
	}
	return parseQueueInfo(text), true
}

// queueText 返回负载逐层展开后的文本（小写），用于标记匹配与字段提取。
func queueText(payload []byte) string {
	layers := []string{string(payload)}
	current := decodeAny(payload)
	for depth := 0; depth < queueLayerDepth; depth++ {
		object, ok := current.(map[string]any)
		if !ok {
			break
		}
		if encoded, err := json.Marshal(object); err == nil {
			layers = append(layers, string(encoded))
		}
		message, ok := object["message"].(string)
		if !ok {
			break
		}
		current = decodeAny([]byte(message))
	}
	return strings.ToLower(strings.Join(layers, "\n"))
}

func decodeAny(payload []byte) any {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil
	}
	return value
}

func parseQueueInfo(text string) QueueInfo {
	info := QueueInfo{}
	if match := queueRetryAfterPattern.FindStringSubmatch(text); match != nil {
		if value, err := strconv.Atoi(match[1]); err == nil {
			info.RetryAfterSeconds = value
		}
	}
	if match := queueWaitTimePattern.FindStringSubmatch(text); match != nil {
		if value, err := strconv.Atoi(match[1]); err == nil {
			info.WaitTime = value
		}
	}
	if match := queueTypePattern.FindStringSubmatch(text); match != nil {
		info.QueueType = match[1]
	}
	return info
}

// ClassifyStreamBusinessFailure 实现 relaycore.StreamBusinessFailureClassifier。
//
// 只判定「可以确定」的两种拒绝：排队，和信封里显式的 4xx/5xx。其余首帧交回
// 原有链路（TransformSSE 会把它转成流内错误），避免在证据不足时误锁账号。
func (*Provider) ClassifyStreamBusinessFailure(
	_ int,
	_ http.Header,
	firstEvent []byte,
) (sharedfailure.Classification, bool) {
	return ClassifyStreamFailure(firstEvent)
}

// ClassifyStreamFailure 是 classifystream 的可测试入口。
func ClassifyStreamFailure(firstEvent []byte) (sharedfailure.Classification, bool) {
	trimmed := bytes.TrimSpace(firstEvent)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("[DONE]")) {
		return sharedfailure.Classification{}, false
	}
	if queue, ok := DetectQueue(trimmed); ok {
		return queueClassification(queue)
	}
	fields, isObject := decodeJSONObject(trimmed)
	if !isObject {
		return sharedfailure.Classification{}, false
	}
	status, hasStatus := envelopeStatus(fields)
	if !hasStatus {
		return sharedfailure.Classification{}, false
	}
	return statusClassification(status)
}

// queueClassification 把排队映射为「模型容量不足」：只冷却账号+模型，不换号，
// 也不硬阻塞账号——排队会自己结束，换号只会让另一个账号也排进同一队列。
func queueClassification(queue QueueInfo) (sharedfailure.Classification, bool) {
	retryAfter := time.Duration(0)
	if queue.RetryAfterSeconds > 0 {
		retryAfter = time.Duration(queue.RetryAfterSeconds) * time.Second
	} else if queue.WaitTime > 0 {
		retryAfter = time.Duration(queue.WaitTime) * time.Second
	}
	if retryAfter > runtimecore.MaxCooldownHint {
		retryAfter = runtimecore.MaxCooldownHint
	}
	classification, err := sharedfailure.NewClassification(
		runtimecore.FailureModelOverloaded,
		retryAfter,
	)
	if err != nil {
		return sharedfailure.Classification{}, false
	}
	return classification, true
}

// statusClassification 只映射证据明确的信封状态码。
func statusClassification(status int) (sharedfailure.Classification, bool) {
	var kind runtimecore.FailureKind
	switch {
	case status == http.StatusTooManyRequests:
		kind = runtimecore.FailureRateLimited
	case status >= http.StatusInternalServerError && status <= 599:
		kind = runtimecore.FailureUpstreamUnavailable
	default:
		return sharedfailure.Classification{}, false
	}
	classification, err := sharedfailure.NewClassification(kind, 0)
	if err != nil {
		return sharedfailure.Classification{}, false
	}
	return classification, true
}

// PresentBusinessFailure 把 qoder 的排队交付成 429 + Retry-After。
//
// 429 而不是 502：排队不是故障，凭据有效、账号健康、请求也没问题，只是上游此刻
// 不给跑；429 是客户端库普遍认得、会按 Retry-After 退避的那个码。
func (*Provider) PresentBusinessFailure(
	classification sharedfailure.Classification,
) relaycore.BusinessFailurePresentation {
	if classification.Kind() != runtimecore.FailureModelOverloaded {
		return relaycore.BusinessFailurePresentation{}
	}
	seconds := int(math.Ceil(classification.RetryAfter().Seconds()))
	if seconds <= 0 {
		seconds = defaultQueueRetrySeconds
	}
	header := make(http.Header)
	header.Set("Retry-After", strconv.Itoa(seconds))
	header.Set(queueIndicatorHeader, "1")
	return relaycore.BusinessFailurePresentation{
		StatusCode: http.StatusTooManyRequests,
		Code:       queueFailureCode,
		Message: fmt.Sprintf(
			"qoder 上游正在排队，本次请求未被处理（约 %d 秒后可重试）。"+
				"排队期间上游不会开始处理你的内容，稍后重试即可。",
			seconds,
		),
		Header: header,
	}
}
