package aihserver

import (
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

// legacyStreamTimeout 是 G3 之前所有 HTTP 流的绝对上限。
const legacyStreamTimeout = 10 * time.Minute

// TestServerWriteTimeoutAllowsLongInferenceStreams 锁定 G3：Server 的写超时不再是会把
// 长推理流硬切断的 10 分钟绝对截止时间。真正把断开判据换成「空闲」的是各复制循环里的
// StreamDeadline.Refresh；Server 这一层只是兜底，因此必须与流总时长同量级，
// 否则流仍会被标准库先切断。
func TestServerWriteTimeoutAllowsLongInferenceStreams(t *testing.T) {
	t.Parallel()

	if writeTimeout != inferenceapi.StreamTotalTimeout {
		t.Fatalf(
			"writeTimeout = %v, want %v",
			writeTimeout,
			inferenceapi.StreamTotalTimeout,
		)
	}
	if writeTimeout <= legacyStreamTimeout {
		t.Fatalf("writeTimeout = %v still caps streams at the old 10 minute limit", writeTimeout)
	}
}

// TestUpstreamClientTimeoutsAllowLongInferenceStreams 验证上游客户端超时不再限制流式
// 推理。http.Client.Timeout 覆盖到响应正文读完，所以它同样是流的绝对上限。
func TestUpstreamClientTimeoutsAllowLongInferenceStreams(t *testing.T) {
	t.Parallel()

	timeouts := map[string]time.Duration{
		"inferenceHTTPTimeout":   inferenceHTTPTimeout,
		"claudeRelayHTTPTimeout": claudeRelayHTTPTimeout,
	}
	for name, timeout := range timeouts {
		if timeout <= legacyStreamTimeout {
			t.Fatalf("%s = %v still caps streams at the old 10 minute limit", name, timeout)
		}
	}
}
