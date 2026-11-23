package inferenceapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/madou1217/ai_home/application/admission"
	"github.com/madou1217/ai_home/application/inferencegateway"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// ServedAccountRefHeader 告诉客户端哪个账号服务了本次请求（与 Node 宿主同名）。
	ServedAccountRefHeader = "x-aih-server-account-ref"
	// ServedProviderHeader 告诉客户端哪个 Provider 服务了本次请求。
	ServedProviderHeader = "x-aih-server-provider"
	// Upstream429RetriesHeader 报告本次请求在上游 429 退避期间完成的额外重试次数（仅 >0 时输出）。
	Upstream429RetriesHeader = "x-aih-upstream-429-retries"
	// Upstream429WaitMSHeader 报告本次请求在上游 429 退避中累计等待的毫秒数（仅 >0 时输出）。
	Upstream429WaitMSHeader = "x-aih-upstream-429-wait-ms"
)

// ContextWithServedAccountHeaders 让每次单账号尝试在响应头提交前写入服务账号，
// 并挂载上游 429 退避重试的诊断头与最终 Retry-After 透传观察者。
//
// 换号重试时后一次尝试覆盖前一次；响应头一旦提交，之后的写入不会出现在线上，
// 与「首个可见字节之后不再换号」的执行合同一致。
func ContextWithServedAccountHeaders(ctx context.Context, response http.ResponseWriter) context.Context {
	if response == nil {
		return ctx
	}
	ctx = inferencegateway.WithAccountObserver(ctx, func(accountRef accountcore.AccountRef, providerID string) {
		response.Header().Set(ServedAccountRefHeader, accountRef.String())
		if providerID != "" {
			response.Header().Set(ServedProviderHeader, providerID)
		}
	})
	return inferencegateway.WithUpstream429HeaderObserver(ctx, func(retries int, totalWait time.Duration, retryAfter string) {
		ApplyUpstream429Headers(response.Header(), retries, totalWait, retryAfter)
	})
}

// ApplyUpstream429Headers 在响应头提交前写入低敏 429 重试诊断头及最终 Retry-After。
func ApplyUpstream429Headers(header http.Header, retries int, totalWait time.Duration, retryAfter string) {
	ApplyUpstream429HeadersWithAction(header, retries, totalWait, retryAfter, false)
}

// ApplyUpstream429HeadersWithAction 在写入诊断头的同时区分「设置剩余 Retry-After」、
// 「清理已过期的权威 Retry-After」与「不改动原头」。
func ApplyUpstream429HeadersWithAction(
	header http.Header,
	retries int,
	totalWait time.Duration,
	retryAfter string,
	clearRetryAfter bool,
) {
	if header == nil {
		return
	}
	if retries > 0 {
		header.Set(Upstream429RetriesHeader, strconv.Itoa(retries))
		waitMS := totalWait.Milliseconds()
		if waitMS < 0 {
			waitMS = 0
		}
		header.Set(Upstream429WaitMSHeader, strconv.FormatInt(waitMS, 10))
	}
	if clearRetryAfter {
		header.Del("Retry-After")
		return
	}
	if retryAfter != "" {
		header.Set("Retry-After", retryAfter)
	}
}

// IsRequestNotRepresentable 判断执行错误是否是「目标协议无法表达该请求」的客户端错误，
// 入站层据此返回 400 而不是 503（与 Node 把上游 400 原样返回的语义一致）。
func IsRequestNotRepresentable(err error) bool {
	return errors.Is(err, inferencegateway.ErrRequestNotRepresentable)
}

// AdmissionRetryAfter 把并发准入拒绝映射成 (秒数, true)；不是准入拒绝时返回 (0,false)。
func AdmissionRetryAfter(err error) (int, bool) {
	rejection, ok := admission.AsRejection(err)
	if !ok {
		return 0, false
	}
	return rejection.RetryAfterSeconds(), true
}

// ApplyAdmissionRetryAfter 准入拒绝时写入 Retry-After 头，返回是否写入。
func ApplyAdmissionRetryAfter(header http.Header, err error) bool {
	seconds, ok := AdmissionRetryAfter(err)
	if !ok {
		return false
	}
	header.Set("Retry-After", strconv.Itoa(seconds))
	return true
}
