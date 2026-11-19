package webuichatapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

const (
	// ArtifactCollectionPath 是 Canonical Chat 产物下载前缀（Node 代理路径转写后的 Go 入口）。
	ArtifactCollectionPath = "/v1/management/webui/chat/artifacts/"
	// legacyArtifactCollectionPath 兼容直接从浏览器路径前缀进入的测试请求。
	legacyArtifactCollectionPath = "/v0/webui/chat/artifacts/"

	defaultSSEReplayBufferLimit = 256
	defaultSSEPendingFrameLimit = 256
	defaultTimelineLimit        = 30
	maxTimelineLimit            = 200
)

// AttachRuntime 在 Handler 构造之后注入或替换 Canonical Chat Runtime 服务与交互协调器。
func (handler *Handler) AttachRuntime(rt *chatruntime.Service, cli *chatruntime.CLIInteractionCoordinator) {
	if handler == nil {
		return
	}
	if cli == nil && rt != nil {
		cli = rt.CLIInteractionCoordinator()
	}
	handler.runtimeMu.Lock()
	handler.runtime = rt
	handler.cliInteractions = cli
	handler.runtimeMu.Unlock()
}

func (handler *Handler) currentRuntime() (*chatruntime.Service, *chatruntime.CLIInteractionCoordinator) {
	if handler == nil {
		return nil, nil
	}
	handler.runtimeMu.RLock()
	rt := handler.runtime
	cli := handler.cliInteractions
	handler.runtimeMu.RUnlock()
	if cli == nil && rt != nil {
		cli = rt.CLIInteractionCoordinator()
	}
	return rt, cli
}

// InProcessChatTurnStreamer 返回复用 Handler 账号调度、上游流改流与用量记账端口的 GoChat 驱动流式器。
func (handler *Handler) InProcessChatTurnStreamer() chatruntime.ChatTurnStreamer {
	return chatruntime.ChatTurnStreamerFunc(func(
		ctx context.Context,
		req chatruntime.ChatTurnStreamRequest,
		emit func(chatruntime.ChatTurnStreamEvent) error,
	) error {
		return handler.streamTurnInProcess(ctx, req, emit)
	})
}

func (handler *Handler) streamTurnInProcess(
	ctx context.Context,
	req chatruntime.ChatTurnStreamRequest,
	emit func(chatruntime.ChatTurnStreamEvent) error,
) error {
	if emit == nil {
		return chatruntime.NewError("chat_stream_callback_required", http.StatusInternalServerError, nil)
	}
	dummyReq, err := http.NewRequestWithContext(ctx, http.MethodPost, "/", nil)
	if err != nil {
		return err
	}
	if accountRef := strings.TrimSpace(req.AccountRef); accountRef != "" {
		dummyReq.Header.Set(inferenceapi.AccountRefHeader, accountRef)
	}

	messages := make([]chatMessage, 0, len(req.Messages))
	lastUserContent := ""
	for _, msg := range req.Messages {
		role, _ := msg["role"].(string)
		role = strings.TrimSpace(role)
		content, _ := msg["content"].(string)
		if role == "" || content == "" {
			continue
		}
		messages = append(messages, chatMessage{Role: role, Content: content})
		if role == "user" {
			lastUserContent = content
		}
	}
	command := turnCommand{
		CommandID:       strings.TrimSpace(req.CommandID),
		Content:         lastUserContent,
		Model:           strings.TrimSpace(req.Model),
		ReasoningEffort: strings.TrimSpace(req.ReasoningEffort),
		Messages:        messages,
	}
	call, routeErr := handler.openUpstream(ctx, dummyReq, command)
	if routeErr != nil {
		return routeErrorToRuntimeError(routeErr)
	}
	defer call.close()

	turn := &turnState{
		turnID:    handler.newID("turn"),
		runID:     handler.newID("run"),
		itemID:    handler.newID("item"),
		model:     command.Model,
		startedAt: handler.clock(),
	}

	emitDelta := func(content string) error {
		if content == "" {
			return nil
		}
		if !turn.itemStarted {
			turn.itemStarted = true
			turn.firstTokenAt = handler.clock()
			if err := emit(chatruntime.ChatTurnStreamEvent{
				Type:      eventTypeTimelineItemStarted,
				ItemID:    turn.itemID,
				Role:      "assistant",
				CreatedAt: turn.startedAt.UnixMilli(),
			}); err != nil {
				return err
			}
		}
		turn.content.WriteString(content)
		return emit(chatruntime.ChatTurnStreamEvent{
			Type:   eventTypeTimelineItemDelta,
			ItemID: turn.itemID,
			Chunk:  content,
		})
	}

	if call.hasFirst {
		if err := emitDelta(call.first.Content); err != nil {
			return err
		}
	}
	if call.reader != nil {
		for {
			next, ok, readErr := call.reader.Next()
			if readErr != nil {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				detail := streamFailureDetail(readErr)
				completedAt := handler.clock()
				handler.recordStreamFailure(context.WithoutCancel(ctx), call.route, call.observation, readErr)
				if turn.itemStarted {
					_ = emit(chatruntime.ChatTurnStreamEvent{
						Type:      eventTypeTimelineItemCompleted,
						ItemID:    turn.itemID,
						Role:      "assistant",
						Content:   turn.content.String(),
						Metrics:   turnMetricsToMap(turn, completedAt, call.usage, call.hasUsage),
						CreatedAt: turn.startedAt.UnixMilli(),
						UpdatedAt: completedAt.UnixMilli(),
					})
				}
				_ = emit(chatruntime.ChatTurnStreamEvent{
					Type:         eventTypeTurnFailed,
					ErrorCode:    detail.Code,
					ErrorMessage: detail.Message,
				})
				return nil
			}
			if !ok {
				break
			}
			if err := emitDelta(next.Content); err != nil {
				return err
			}
		}
		usage, hasUsage := call.reader.Result()
		call.usage, call.hasUsage = usage, hasUsage
	}

	completedAt := handler.clock()
	handler.recordUsage(ctx, call)
	if turn.itemStarted {
		if err := emit(chatruntime.ChatTurnStreamEvent{
			Type:      eventTypeTimelineItemCompleted,
			ItemID:    turn.itemID,
			Role:      "assistant",
			Content:   turn.content.String(),
			Metrics:   turnMetricsToMap(turn, completedAt, call.usage, call.hasUsage),
			CreatedAt: turn.startedAt.UnixMilli(),
			UpdatedAt: completedAt.UnixMilli(),
		}); err != nil {
			return err
		}
	}
	return emit(chatruntime.ChatTurnStreamEvent{Type: eventTypeTurnCompleted})
}

func turnMetricsToMap(turn *turnState, completedAt time.Time, usage inference.Usage, hasUsage bool) map[string]any {
	metrics := turn.metrics(completedAt, usage, hasUsage)
	out := map[string]any{
		"durationMs": metrics.DurationMS,
	}
	if metrics.TTFTMS != nil {
		out["ttftMs"] = *metrics.TTFTMS
	}
	if metrics.InputTokens != nil {
		out["inputTokens"] = int64(*metrics.InputTokens)
	}
	if metrics.OutputTokens != nil {
		out["outputTokens"] = int64(*metrics.OutputTokens)
	}
	if metrics.TokensPerSec != nil {
		out["tokensPerSec"] = *metrics.TokensPerSec
	}
	return out
}

func routeErrorToRuntimeError(routeErr *routeError) *chatruntime.Error {
	if routeErr == nil {
		return chatruntime.NewError("chat_runtime_failed", http.StatusInternalServerError, nil)
	}
	var details map[string]any
	if mapped, ok := routeErr.Details.(map[string]any); ok {
		details = mapped
	}
	return chatruntime.NewErrorWithMessage(routeErr.Code, routeErr.Status, routeErr.Message, details)
}

// ServeSessionsCollection 处理 GET / POST <sessions> 集合入口。
func (handler *Handler) ServeSessionsCollection(response http.ResponseWriter, request *http.Request) {
	if !handler.authorizer.Authorized(request) {
		writeRouteError(response, newRouteError(
			http.StatusUnauthorized, "chat_runtime_unauthorized", "管理凭据无效", nil,
		))
		return
	}
	rt, _ := handler.currentRuntime()
	if rt == nil {
		writeRouteError(response, newRouteError(
			http.StatusServiceUnavailable, "chat_runtime_unavailable", "聊天运行时尚未就绪", nil,
		))
		return
	}
	switch request.Method {
	case http.MethodPost:
		var dto chatruntime.CreateSessionInput
		if routeErr := decodeJSONObject(request, handler.maxBodyBytes, &dto); routeErr != nil {
			writeRouteError(response, routeErr)
			return
		}
		isChat := strings.TrimSpace(dto.ProjectPath) == ""
		var (
			sess *chatruntime.Session
			err  error
		)
		if isChat {
			sess, err = rt.OpenChatSession(request.Context(), chatruntime.OpenChatSessionInput{
				ChatSessionID:       dto.ChatSessionID,
				Provider:            dto.Provider,
				ExecutionAccountRef: dto.ExecutionAccountRef,
				ReadOnly:            dto.ReadOnly,
			})
		} else {
			sess, err = rt.CreateSession(request.Context(), chatruntime.CreateSessionInput{
				ChatSessionID:       dto.ChatSessionID,
				Provider:            dto.Provider,
				ExecutionAccountRef: dto.ExecutionAccountRef,
				ProjectPath:         dto.ProjectPath,
				Policy:              dto.Policy,
				ReadOnly:            dto.ReadOnly,
			})
		}
		if err != nil {
			writeRuntimeError(response, err)
			return
		}
		writeJSONResponse(response, http.StatusCreated, map[string]any{
			"ok":      true,
			"session": sess,
		})
		rt.ScheduleSessionPrewarm(sess)
	case http.MethodGet:
		query := request.URL.Query()
		sessions, err := rt.ListSessions(request.Context(), chatruntime.ListSessionsFilter{
			Provider:        strings.TrimSpace(query.Get("provider")),
			ProjectPath:     strings.TrimSpace(query.Get("projectPath")),
			NativeSessionID: strings.TrimSpace(query.Get("nativeSessionId")),
		})
		if err != nil {
			writeRuntimeError(response, err)
			return
		}
		if sessions == nil {
			sessions = []chatruntime.Session{}
		}
		writeJSONResponse(response, http.StatusOK, map[string]any{
			"ok":       true,
			"sessions": sessions,
		})
	default:
		writeMethodNotAllowed(response, http.MethodGet+", "+http.MethodPost)
	}
}

// ServeArtifact 处理 GET /v1/management/webui/chat/artifacts/{artifactId} 产物下载。
func (handler *Handler) ServeArtifact(response http.ResponseWriter, request *http.Request) {
	if !handler.authorizer.Authorized(request) {
		writeRouteError(response, newRouteError(
			http.StatusUnauthorized, "chat_runtime_unauthorized", "管理凭据无效", nil,
		))
		return
	}
	rt, _ := handler.currentRuntime()
	if rt == nil {
		writeRouteError(response, newRouteError(
			http.StatusServiceUnavailable, "chat_runtime_unavailable", "聊天运行时尚未就绪", nil,
		))
		return
	}
	if request.Method != http.MethodGet {
		writeMethodNotAllowed(response, http.MethodGet)
		return
	}
	artifactID := extractArtifactID(request)
	if artifactID == "" {
		writeRouteError(response, newRouteError(
			http.StatusNotFound, "artifact_not_found", "artifact_not_found", nil,
		))
		return
	}
	artifact, err := rt.ReadArtifact(request.Context(), artifactID)
	if err != nil {
		writeRuntimeError(response, err)
		return
	}
	if artifact == nil || artifact.Body == nil {
		writeRouteError(response, newRouteError(
			http.StatusNotFound, "artifact_not_found", "artifact_not_found", nil,
		))
		return
	}
	contentType := strings.TrimSpace(artifact.ContentType)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	response.Header().Set("Content-Type", contentType)
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(artifact.Body)
}

func extractArtifactID(request *http.Request) string {
	if request == nil {
		return ""
	}
	if raw := strings.TrimSpace(request.PathValue("artifactId")); raw != "" {
		if decoded, err := url.PathUnescape(raw); err == nil {
			return strings.TrimSpace(decoded)
		}
		return raw
	}
	path := request.URL.Path
	for _, prefix := range []string{ArtifactCollectionPath, legacyArtifactCollectionPath} {
		if strings.HasPrefix(path, prefix) {
			raw := strings.TrimPrefix(path, prefix)
			if decoded, err := url.PathUnescape(raw); err == nil {
				return strings.TrimSpace(decoded)
			}
			return strings.TrimSpace(raw)
		}
	}
	return ""
}

func (handler *Handler) serveCollectionSubpath(
	response http.ResponseWriter,
	request *http.Request,
	rt *chatruntime.Service,
	cli *chatruntime.CLIInteractionCoordinator,
) {
	path := request.URL.Path
	if path == strings.TrimSuffix(handler.commandPath, "/") {
		handler.ServeSessionsCollection(response, request)
		return
	}
	if !strings.HasPrefix(path, handler.commandPath) {
		writeRouteError(response, newRouteError(
			http.StatusNotFound, "chat_runtime_route_not_found", "没有这个聊天路由", nil,
		))
		return
	}
	rest := strings.TrimPrefix(path, handler.commandPath)
	if rest == "" {
		handler.ServeSessionsCollection(response, request)
		return
	}
	if rest == "resolve" {
		handler.handleResolveSession(response, request, rt)
		return
	}
	sessionPart, suffix, hasSlash := strings.Cut(rest, "/")
	sessionID, err := url.PathUnescape(sessionPart)
	if sessionPart == "" || err != nil || strings.TrimSpace(sessionID) == "" {
		writeRouteError(response, newRouteError(
			http.StatusNotFound, "chat_runtime_route_not_found", "没有这个聊天路由", nil,
		))
		return
	}
	if !hasSlash {
		if request.Method != http.MethodDelete {
			writeMethodNotAllowed(response, http.MethodDelete)
			return
		}
		deleted, derr := rt.DeleteSession(request.Context(), sessionID)
		if derr != nil {
			writeRuntimeError(response, derr)
			return
		}
		writeJSONResponse(response, http.StatusOK, mergeOKMap(map[string]any{"deleted": true}, deleted))
		return
	}
	switch suffix {
	case "snapshot":
		handler.handleSessionSnapshot(response, request, rt, sessionID)
	case "timeline":
		handler.handleSessionTimeline(response, request, rt, sessionID)
	case "commands/catalog":
		handler.handleSessionCommandCatalog(response, request, rt, sessionID)
	case "composer/catalog":
		handler.handleSessionComposerCatalog(response, request, rt, sessionID)
	case "commands":
		handler.handleSessionCommands(response, request, rt, cli, sessionID)
	case "attachments":
		handler.handleSessionAttachments(response, request, rt, sessionID)
	case "events":
		handler.handleSessionEvents(response, request, rt, sessionID)
	case "checkpoints":
		handler.handleSessionCheckpoints(response, request, rt, sessionID, "list")
	case "checkpoints/changes":
		handler.handleSessionCheckpoints(response, request, rt, sessionID, "changes")
	case "checkpoints/restore":
		handler.handleSessionCheckpoints(response, request, rt, sessionID, "restore")
	default:
		writeRouteError(response, newRouteError(
			http.StatusNotFound, "chat_runtime_route_not_found", "没有这个聊天路由", nil,
		))
	}
}

func (handler *Handler) handleResolveSession(
	response http.ResponseWriter,
	request *http.Request,
	rt *chatruntime.Service,
) {
	if request.Method != http.MethodPost {
		writeMethodNotAllowed(response, http.MethodPost)
		return
	}
	var input chatruntime.CreateSessionInput
	if routeErr := decodeJSONObject(request, handler.maxBodyBytes, &input); routeErr != nil {
		writeRouteError(response, routeErr)
		return
	}
	result, err := rt.ResolveSession(request.Context(), input)
	if err != nil {
		writeRuntimeError(response, err)
		return
	}
	status := http.StatusOK
	if result != nil && result.Status == "created" {
		status = http.StatusCreated
	}
	writeJSONResponse(response, status, map[string]any{
		"ok":      true,
		"status":  result.Status,
		"session": result.Session,
	})
	if result != nil && result.Status == "created" && result.Session != nil {
		rt.ScheduleSessionPrewarm(result.Session)
	}
}

func (handler *Handler) handleSessionSnapshot(
	response http.ResponseWriter,
	request *http.Request,
	rt *chatruntime.Service,
	sessionID string,
) {
	if request.Method != http.MethodGet {
		writeMethodNotAllowed(response, http.MethodGet)
		return
	}
	snap, err := rt.GetSnapshot(request.Context(), sessionID)
	if err != nil {
		writeRuntimeError(response, err)
		return
	}
	writeJSONResponse(response, http.StatusOK, map[string]any{
		"ok":       true,
		"snapshot": snap,
	})
}

func (handler *Handler) handleSessionTimeline(
	response http.ResponseWriter,
	request *http.Request,
	rt *chatruntime.Service,
	sessionID string,
) {
	if request.Method != http.MethodGet {
		writeMethodNotAllowed(response, http.MethodGet)
		return
	}
	query := request.URL.Query()
	before := strings.TrimSpace(query.Get("before"))
	limit := parseTimelineLimit(query.Get("limit"))
	timeline, err := rt.ReadTimeline(request.Context(), sessionID, before, limit)
	if err != nil {
		writeRuntimeError(response, err)
		return
	}
	writeJSONResponse(response, http.StatusOK, map[string]any{
		"ok":       true,
		"timeline": timeline,
	})
}

func (handler *Handler) handleSessionCommandCatalog(
	response http.ResponseWriter,
	request *http.Request,
	rt *chatruntime.Service,
	sessionID string,
) {
	if request.Method != http.MethodGet {
		writeMethodNotAllowed(response, http.MethodGet)
		return
	}
	commands, err := rt.GetCommandCatalog(request.Context(), sessionID)
	if err != nil {
		writeRuntimeError(response, err)
		return
	}
	if commands == nil {
		commands = []chatruntime.CommandCatalogEntry{}
	}
	writeJSONResponse(response, http.StatusOK, map[string]any{
		"ok":       true,
		"commands": commands,
	})
}

func (handler *Handler) handleSessionComposerCatalog(
	response http.ResponseWriter,
	request *http.Request,
	rt *chatruntime.Service,
	sessionID string,
) {
	if request.Method != http.MethodGet {
		writeMethodNotAllowed(response, http.MethodGet)
		return
	}
	catalog, err := rt.ReadComposerCatalog(request.Context(), sessionID)
	if err != nil {
		writeRuntimeError(response, err)
		return
	}
	writeJSONResponse(response, http.StatusOK, map[string]any{
		"ok":      true,
		"catalog": catalog,
	})
}

func (handler *Handler) handleSessionCommands(
	response http.ResponseWriter,
	request *http.Request,
	rt *chatruntime.Service,
	cli *chatruntime.CLIInteractionCoordinator,
	sessionID string,
) {
	if request.Method != http.MethodPost {
		writeMethodNotAllowed(response, http.MethodPost)
		return
	}
	var command map[string]any
	if routeErr := decodeJSONObject(request, handler.maxBodyBytes, &command); routeErr != nil {
		writeRouteError(response, routeErr)
		return
	}
	var (
		result  map[string]any
		handled bool
		err     error
	)
	if cli != nil {
		result, handled, err = cli.Dispatch(request.Context(), sessionID, command)
		if err != nil {
			writeRuntimeError(response, err)
			return
		}
	}
	if !handled {
		result, err = rt.DispatchCommand(request.Context(), sessionID, command)
		if err != nil {
			writeRuntimeError(response, err)
			return
		}
	}
	writeJSONResponse(response, http.StatusAccepted, mergeOKMap(nil, result))
}

func (handler *Handler) handleSessionAttachments(
	response http.ResponseWriter,
	request *http.Request,
	rt *chatruntime.Service,
	sessionID string,
) {
	if request.Method != http.MethodPost {
		writeMethodNotAllowed(response, http.MethodPost)
		return
	}
	var payload struct {
		Attachments []chatruntime.AttachmentUploadInput `json:"attachments"`
	}
	if routeErr := decodeJSONObject(request, chatruntime.MaxAttachmentHTTPBodyBytes, &payload); routeErr != nil {
		writeRouteError(response, routeErr)
		return
	}
	attachments, err := rt.UploadAttachments(request.Context(), sessionID, payload.Attachments)
	if err != nil {
		writeRuntimeError(response, err)
		return
	}
	if attachments == nil {
		attachments = []chatruntime.Attachment{}
	}
	writeJSONResponse(response, http.StatusCreated, map[string]any{
		"ok":          true,
		"sessionId":   sessionID,
		"attachments": attachments,
	})
}

func (handler *Handler) handleSessionCheckpoints(
	response http.ResponseWriter,
	request *http.Request,
	rt *chatruntime.Service,
	sessionID string,
	action string,
) {
	commit := ""
	switch action {
	case "list":
		if request.Method != http.MethodGet {
			writeMethodNotAllowed(response, http.MethodGet)
			return
		}
	case "changes":
		if request.Method != http.MethodGet {
			writeMethodNotAllowed(response, http.MethodGet)
			return
		}
		commit = strings.TrimSpace(request.URL.Query().Get("commit"))
	case "restore":
		if request.Method != http.MethodPost {
			writeMethodNotAllowed(response, http.MethodPost)
			return
		}
		var body struct {
			Commit string `json:"commit"`
		}
		if routeErr := decodeJSONObject(request, handler.maxBodyBytes, &body); routeErr != nil {
			writeRouteError(response, routeErr)
			return
		}
		commit = strings.TrimSpace(body.Commit)
	default:
		writeRouteError(response, newRouteError(
			http.StatusNotFound, "chat_runtime_route_not_found", "没有这个聊天路由", nil,
		))
		return
	}
	res, err := rt.WorkspaceCheckpointAction(request.Context(), sessionID, action, commit)
	if err != nil {
		writeRuntimeError(response, err)
		return
	}
	merged, err := structToFlatMapWithOK(res)
	if err != nil {
		writeRuntimeError(response, err)
		return
	}
	writeJSONResponse(response, http.StatusOK, merged)
}

type sseLiveState struct {
	mu        sync.Mutex
	replaying bool
	closed    bool
	replayBuf []chatruntime.EventEnvelope
	liveBuf   []chatruntime.EventEnvelope
	errCode   string
}

func (handler *Handler) handleSessionEvents(
	response http.ResponseWriter,
	request *http.Request,
	rt *chatruntime.Service,
	sessionID string,
) {
	if request.Method != http.MethodGet {
		writeMethodNotAllowed(response, http.MethodGet)
		return
	}
	flusher, ok := response.(http.Flusher)
	if !ok {
		writeRouteError(response, newRouteError(
			http.StatusInternalServerError, "chat_runtime_stream_unsupported", "当前连接不支持流式交付", nil,
		))
		return
	}

	cursor := resolveSSEAfterCursor(request)
	deadline := inferenceapi.NewStreamDeadline(response)

	header := response.Header()
	header.Set("Content-Type", "text/event-stream; charset=utf-8")
	header.Set("Cache-Control", "no-cache, no-transform")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)
	flusher.Flush()
	deadline.Refresh()

	writeFrame := func(frame []byte) bool {
		if _, err := response.Write(frame); err != nil {
			return false
		}
		flusher.Flush()
		deadline.Refresh()
		return true
	}

	emitTransportError := func(err error) {
		diag := chatruntime.SanitizeCanonicalDiagnostic(err, chatruntime.DiagnosticOptions{
			FallbackCode:    "chat_runtime_stream_failed",
			FallbackMessage: "unknown",
		})
		nowMS := handler.clock().UnixMilli()
		ev := chatruntime.EventEnvelope{
			Schema:    EventSchema,
			EventID:   fmt.Sprintf("stream.error-%s-%d", sessionID, nowMS),
			SessionID: sessionID,
			Seq:       0,
			Type:      "stream.error",
			At:        nowMS,
			Source:    chatruntime.EventSource{Provider: "unknown", RuntimeID: "aih-chat-runtime"},
			Payload:   map[string]any{"error": diag.Code, "message": diag.Message},
		}
		if frame, ferr := encodeRuntimeEventFrame(ev); ferr == nil {
			_ = writeFrame(frame)
		}
	}

	emitAfterCursor := func(ev chatruntime.EventEnvelope) bool {
		seq := ev.Seq
		if seq > 0 && seq <= cursor {
			return true
		}
		frame, err := encodeRuntimeEventFrame(ev)
		if err != nil {
			return true
		}
		if !writeFrame(frame) {
			return false
		}
		if seq > 0 {
			cursor = seq
		}
		return true
	}

	emitSnapshotReset := func(snap *chatruntime.Snapshot) bool {
		if snap == nil {
			return true
		}
		seq := snap.ThroughSeq
		if seq < 0 {
			seq = 0
		}
		raw, err := json.Marshal(snap)
		if err != nil {
			return false
		}
		var payload map[string]any
		if err := json.Unmarshal(raw, &payload); err != nil {
			return false
		}
		nowMS := handler.clock().UnixMilli()
		ev := chatruntime.EventEnvelope{
			Schema:    EventSchema,
			EventID:   fmt.Sprintf("session.snapshot.reset-%s-%d", sessionID, nowMS),
			SessionID: sessionID,
			Seq:       seq,
			Type:      "session.snapshot.reset",
			At:        nowMS,
			Source:    chatruntime.EventSource{Provider: "unknown", RuntimeID: "aih-chat-runtime"},
			Payload:   payload,
		}
		frame, err := encodeRuntimeEventFrame(ev)
		if err != nil {
			return false
		}
		if !writeFrame(frame) {
			return false
		}
		cursor = seq
		return true
	}

	state := &sseLiveState{replaying: true}
	notifyCh := make(chan struct{}, 1)
	signalNotify := func() {
		select {
		case notifyCh <- struct{}{}:
		default:
		}
	}

	unsubscribe, err := rt.Subscribe(sessionID, func(ev chatruntime.EventEnvelope) {
		state.mu.Lock()
		defer state.mu.Unlock()
		if state.closed || state.errCode != "" {
			return
		}
		if state.replaying {
			if len(state.replayBuf) >= defaultSSEReplayBufferLimit {
				state.errCode = "chat_runtime_replay_buffer_overflow"
				signalNotify()
				return
			}
			state.replayBuf = append(state.replayBuf, ev)
			return
		}
		if len(state.liveBuf) >= defaultSSEPendingFrameLimit {
			state.errCode = "chat_runtime_backpressure_overflow"
			signalNotify()
			return
		}
		state.liveBuf = append(state.liveBuf, ev)
		signalNotify()
	})
	if err != nil {
		emitTransportError(err)
		return
	}
	defer func() {
		state.mu.Lock()
		state.closed = true
		state.replayBuf = nil
		state.liveBuf = nil
		state.mu.Unlock()
		if unsubscribe != nil {
			unsubscribe()
		}
	}()

	replay, err := rt.ReadEvents(request.Context(), sessionID, cursor)
	if err != nil {
		emitTransportError(err)
		return
	}

	state.mu.Lock()
	buf := state.replayBuf
	state.replayBuf = nil
	state.replaying = false
	overflowCode := state.errCode
	state.mu.Unlock()

	if overflowCode != "" {
		emitTransportError(chatruntime.NewError(overflowCode, http.StatusServiceUnavailable, nil))
		return
	}

	if replay.Gap && replay.Snapshot != nil {
		if !emitSnapshotReset(replay.Snapshot) {
			return
		}
	}
	for _, ev := range replay.Events {
		if request.Context().Err() != nil {
			return
		}
		if !emitAfterCursor(ev) {
			return
		}
	}
	sort.SliceStable(buf, func(i, j int) bool {
		return buf[i].Seq < buf[j].Seq
	})
	for _, ev := range buf {
		if request.Context().Err() != nil {
			return
		}
		if !emitAfterCursor(ev) {
			return
		}
	}

	var heartbeatC <-chan time.Time
	var ticker *time.Ticker
	if handler.heartbeatInterval > 0 {
		ticker = time.NewTicker(handler.heartbeatInterval)
		heartbeatC = ticker.C
		defer ticker.Stop()
	}

	for {
		state.mu.Lock()
		batch := state.liveBuf
		state.liveBuf = nil
		errCode := state.errCode
		state.mu.Unlock()

		if errCode != "" {
			emitTransportError(chatruntime.NewError(errCode, http.StatusServiceUnavailable, nil))
			return
		}
		for _, ev := range batch {
			if request.Context().Err() != nil {
				return
			}
			if !emitAfterCursor(ev) {
				return
			}
		}

		select {
		case <-request.Context().Done():
			return
		case <-notifyCh:
		case <-heartbeatC:
			if !writeFrame([]byte(heartbeatFrame)) {
				return
			}
		}
	}
}

func encodeRuntimeEventFrame(event chatruntime.EventEnvelope) ([]byte, error) {
	data, err := json.Marshal(event)
	if err != nil {
		return nil, err
	}
	var frame bytes.Buffer
	if event.Seq > 0 {
		fmt.Fprintf(&frame, "id: %d\n", event.Seq)
	}
	fmt.Fprintf(&frame, "event: %s\ndata: %s\n\n", event.Type, data)
	return frame.Bytes(), nil
}

func resolveSSEAfterCursor(request *http.Request) int64 {
	if request == nil || request.URL == nil {
		return 0
	}
	q := request.URL.Query()
	if q.Has("after") {
		return parseSSESequence(q.Get("after"))
	}
	return parseSSESequence(request.Header.Get("Last-Event-ID"))
}

func parseSSESequence(raw string) int64 {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return 0
	}
	parsed, err := strconv.ParseInt(trimmed, 10, 64)
	if err != nil || parsed < 0 {
		return 0
	}
	return parsed
}

func parseTimelineLimit(raw string) int {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return defaultTimelineLimit
	}
	parsed, err := strconv.Atoi(trimmed)
	if err != nil {
		return defaultTimelineLimit
	}
	if parsed < 1 {
		return 1
	}
	if parsed > maxTimelineLimit {
		return maxTimelineLimit
	}
	return parsed
}

func decodeJSONObject(request *http.Request, limit int64, target any) *routeError {
	body, err := readRequestBody(request, limit)
	if err != nil {
		return newRouteError(
			statusBadRequest, "invalid_chat_runtime_payload", "请求体无法读取或超过上限", nil,
		)
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		trimmed = []byte("{}")
	}
	if trimmed[0] != '{' {
		return newRouteError(
			statusBadRequest, "invalid_chat_runtime_payload", "请求体必须是 JSON 对象", nil,
		)
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	if err := decoder.Decode(target); err != nil {
		return newRouteError(
			statusBadRequest, "invalid_chat_runtime_payload", "请求体不是有效 JSON 对象", nil,
		)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return newRouteError(
			statusBadRequest, "invalid_chat_runtime_payload", "请求体包含多余 JSON 内容", nil,
		)
	}
	return nil
}

func writeMethodNotAllowed(response http.ResponseWriter, allow string) {
	if allow != "" {
		response.Header().Set("Allow", allow)
	}
	writeRouteError(response, newRouteError(
		http.StatusMethodNotAllowed, "chat_runtime_method_not_allowed", "请求方法不受支持", nil,
	))
}

func writeRuntimeError(response http.ResponseWriter, err error) {
	diag := chatruntime.SanitizeCanonicalDiagnostic(err, chatruntime.DiagnosticOptions{
		FallbackCode:      "chat_runtime_failed",
		IncludeDetails:    true,
		IncludeStatusCode: true,
	})
	status := diag.StatusCode
	if status < 400 || status > 599 {
		status = http.StatusInternalServerError
	}
	payload := map[string]any{
		"ok":      false,
		"error":   diag.Code,
		"message": diag.Message,
	}
	if diag.Details != nil {
		payload["details"] = diag.Details
	}
	writeJSONResponse(response, status, payload)
}

func writeJSONResponse(response http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		status = http.StatusInternalServerError
		body = []byte(`{"ok":false,"error":"chat_runtime_failed","message":"聊天请求序列化失败"}`)
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_, _ = response.Write(body)
}

func mergeOKMap(base map[string]any, extra map[string]any) map[string]any {
	out := map[string]any{"ok": true}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

func structToFlatMapWithOK(val any) (map[string]any, error) {
	raw, err := json.Marshal(val)
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	if len(raw) > 0 && raw[0] == '{' {
		if err := json.Unmarshal(raw, &out); err != nil {
			return nil, err
		}
	}
	out["ok"] = true
	return out, nil
}
