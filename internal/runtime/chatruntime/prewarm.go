package chatruntime

import (
	"context"
	"maps"
	"strings"
)

// WithRuntimePrewarmLifecycle 为 DriverEntry 的 "runtime.prewarm" 处理器包装 started/ready/failed 事件投影。
func WithRuntimePrewarmLifecycle(entry DriverEntry) DriverEntry {
	if entry.Handlers == nil {
		return entry
	}
	effect, ok := entry.Handlers["runtime.prewarm"]
	if !ok || effect == nil {
		return entry
	}
	nextHandlers := maps.Clone(entry.Handlers)
	nextHandlers["runtime.prewarm"] = CreateRuntimePrewarmHandler(effect)
	entry.Handlers = nextHandlers
	return entry
}

// CreateRuntimePrewarmHandler 创建发射 runtime.prewarm.started / ready / failed 事件的预热处理器。
func CreateRuntimePrewarmHandler(providerEffect CommandHandler) CommandHandler {
	if providerEffect == nil {
		return func(context.Context, CommandHandlerContext) (map[string]any, error) {
			return nil, NewError("chat_runtime_prewarm_handler_required", 500, nil)
		}
	}
	return func(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
		if hctx.Store == nil {
			return nil, NewError("chat_runtime_prewarm_context_invalid", 500, nil)
		}
		sess, err := hctx.Store.GetSession(ctx, strings.TrimSpace(hctx.SessionID))
		if err != nil || sess == nil {
			return nil, NewError("chat_runtime_prewarm_context_invalid", 500, nil)
		}
		if err := appendPrewarmProjection(ctx, hctx.Store, sess, "runtime.prewarm.started"); err != nil {
			return nil, err
		}
		res, effectErr := providerEffect(ctx, hctx)
		if effectErr != nil {
			_ = appendPrewarmFailure(ctx, hctx.Store, sess, effectErr)
			return nil, effectErr
		}
		if err := appendPrewarmProjection(ctx, hctx.Store, sess, "runtime.prewarm.ready"); err != nil {
			return nil, err
		}
		return res, nil
	}
}

func appendPrewarmProjection(ctx context.Context, store *PublishingStore, sess *Session, evType string) error {
	_, err := store.AppendEvent(ctx, sess.SessionID, EventDraft{
		Type:   evType,
		Source: sessionEventSource(sess),
		Payload: map[string]any{
			"runtimeBinding":     CloneMap(sess.RuntimeBinding),
			"capabilitySnapshot": CloneMap(sess.CapabilitySnapshot),
		},
	})
	return err
}

func appendPrewarmFailure(ctx context.Context, store *PublishingStore, sess *Session, err error) error {
	code := "runtime_prewarm_failed"
	if rtErr, ok := AsRuntimeError(err); ok && strings.TrimSpace(rtErr.Code) != "" {
		code = rtErr.Code
	}
	_, appendErr := store.AppendEvent(ctx, sess.SessionID, EventDraft{
		Type:   "runtime.prewarm.failed",
		Source: sessionEventSource(sess),
		Payload: map[string]any{
			"error":   code,
			"message": DescribeRuntimeFailure(code, sess.Provider),
		},
	})
	return appendErr
}

// ScheduleSessionPrewarm 异步触发会话运行时预热（用于 Service 后台调度）。
func ScheduleSessionPrewarm(ctx context.Context, dispatcher interface {
	DispatchCommand(ctx context.Context, sessionID string, input map[string]any) (map[string]any, error)
}, idFactory func(string) string, session *Session) {
	if dispatcher == nil || session == nil || strings.TrimSpace(session.SessionID) == "" {
		return
	}
	if idFactory == nil {
		idFactory = DefaultIDFactory
	}
	cmdID := "runtime-prewarm:" + strings.TrimPrefix(idFactory("prewarm"), "prewarm-")
	sid := session.SessionID
	go func() {
		_, _ = dispatcher.DispatchCommand(ctx, sid, map[string]any{
			"commandId": cmdID,
			"type":      "runtime.prewarm",
			"payload":   map[string]any{},
		})
	}()
}
