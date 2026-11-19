package images

import "context"

// SubmissionGate 在 sendUpstream 即将执行真实图片生成/编辑 HTTP POST（doer.Do）之前
// 同步执行最后门禁检查。仅作用于 sendUpstream，不影响策略前置 prepare 或事后图片回取 Fetch。
type SubmissionGate func(ctx context.Context) error

// SubmissionAcceptedObserver 在 sendUpstream 收到上游 HTTP 2xx 响应时触发一次，
// 标记本次请求已存在上游接受的生成/编辑提交（即便后续 body 读取、解析或本地转码失败）。
type SubmissionAcceptedObserver func()

type submissionGateContextKey struct{}
type submissionAcceptedContextKey struct{}

// ContextWithSubmissionGate 把单次提交前门禁绑定到 ctx；gate 为 nil 时清除门禁。
func ContextWithSubmissionGate(ctx context.Context, gate SubmissionGate) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, submissionGateContextKey{}, gate)
}

// ContextWithSubmissionAccepted 把上游 2xx 提交接受观察者绑定到 ctx。
func ContextWithSubmissionAccepted(ctx context.Context, observer SubmissionAcceptedObserver) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, submissionAcceptedContextKey{}, observer)
}

func checkSubmissionGate(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	gate, ok := ctx.Value(submissionGateContextKey{}).(SubmissionGate)
	if !ok || gate == nil {
		return nil
	}
	return gate(ctx)
}

func notifySubmissionAccepted(ctx context.Context) {
	if ctx == nil {
		return
	}
	observer, ok := ctx.Value(submissionAcceptedContextKey{}).(SubmissionAcceptedObserver)
	if !ok || observer == nil {
		return
	}
	observer()
}
