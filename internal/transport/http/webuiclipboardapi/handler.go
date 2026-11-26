// Package webuiclipboardapi exposes the clipboard management HTTP API under /v1/management/webui/clipboard.
//
//	GET    /v1/management/webui/clipboard/items
//	POST   /v1/management/webui/clipboard/items
//	GET    /v1/management/webui/clipboard/items/{id}
//	GET    /v1/management/webui/clipboard/items/{id}/content
//	DELETE /v1/management/webui/clipboard/items/{id}
//	POST   /v1/management/webui/clipboard/items/{id}/pin
//	GET    /v1/management/webui/clipboard/settings
//	PATCH  /v1/management/webui/clipboard/settings
//	GET    /v1/management/webui/clipboard/status
//	GET    /v1/management/webui/clipboard/servers
//	POST   /v1/management/webui/clipboard/sync-run   (public alias /v0/webui/clipboard/sync-run)
//	POST   /v1/management/webui/clipboard/sync/run   (management-only, SkipPublicAlias)
//	GET    /v1/management/webui/clipboard/sync/key   (management-only, SkipPublicAlias)
//	GET    /v1/management/webui/clipboard/events     (SSE change feed)
//	POST   /v1/management/webui/clipboard/sync/key   (management-only, SkipPublicAlias)
//	POST   /v1/management/webui/clipboard/sync/items (management-only, SkipPublicAlias)
//	GET    /v1/management/webui/clipboard/sync/items (management-only, SkipPublicAlias)
package webuiclipboardapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/madou1217/ai_home/application/clipboard"
	"github.com/madou1217/ai_home/internal/runtime/clipboardpreview"
	"github.com/madou1217/ai_home/internal/runtime/clipboardruntime"
)

const (
	// Path is the canonical management route prefix; router auto-generates /v0/webui/clipboard
	// for non-skipped routes. Sync routes under Path + "/sync/" must set SkipPublicAlias: true.
	Path = "/v1/management/webui/clipboard"
)

// Authorizer validates management-key requests.
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// ServerProfileView is the sanitized sync-target server catalog returned to WebUI (no keys).
type ServerProfileView struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Endpoint string `json:"endpoint"`
	Active   bool   `json:"active"`
}

// Handler serves clipboard management API requests.
type Handler struct {
	Authorizer        Authorizer
	Service           *clipboard.Service
	Servers           func(context.Context) ([]ServerProfileView, error)
	SyncRun           func(context.Context) error
	Transfers         *clipboardruntime.TransferReceiver
	MaxBody           int64
	OnSettingsChanged func(clipboard.Settings)
}

// NewHandler constructs a clipboard API handler.
func NewHandler(authorizer Authorizer, service *clipboard.Service) (*Handler, error) {
	if authorizer == nil || service == nil {
		return nil, errors.New("clipboard_handler_dependencies_invalid")
	}
	return &Handler{
		Authorizer: authorizer,
		Service:    service,
		Transfers:  clipboardruntime.NewTransferReceiver(service),
		MaxBody:    clipboard.MaxRequestBytes,
	}, nil
}

// ServeHTTP dispatches clipboard routes under Path.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Service == nil {
		writeError(w, http.StatusServiceUnavailable, "clipboard_unavailable", "剪贴板服务未就绪")
		return
	}
	if h.Authorizer == nil || !h.Authorizer.Authorized(r) {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeError(w, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	rawPath := strings.TrimSpace(r.URL.Path)
	if !strings.HasPrefix(rawPath, Path) {
		writeError(w, http.StatusNotFound, "not_found", "没有这个剪贴板路由")
		return
	}
	rest := strings.Trim(strings.TrimPrefix(rawPath, Path), "/")
	switch {
	case rest == "items":
		h.handleItemsCollection(w, r)
	case strings.HasPrefix(rest, "items/"):
		h.handleItemSubroute(w, r, strings.TrimPrefix(rest, "items/"))
	case rest == "settings":
		h.handleSettings(w, r)
	case rest == "status":
		h.handleStatus(w, r)
	case rest == "events":
		h.handleEvents(w, r)
	case rest == "servers":
		h.handleServers(w, r)
	case rest == "sync/key":
		h.handleSyncKey(w, r)
	case rest == "sync/transfers":
		h.handleSyncTransfer(w, r)
	case rest == "sync/items":
		h.handleSyncItems(w, r)
	case rest == "sync/requests":
		h.handleSyncRequests(w, r)
	case rest == "sync/run", rest == "sync-run":
		h.handleSyncRun(w, r)
	default:
		writeError(w, http.StatusNotFound, "not_found", "没有这个剪贴板路由")
	}
}

type itemView struct {
	ID               string         `json:"id"`
	SHA256           string         `json:"sha256"`
	Kind             clipboard.Kind `json:"kind"`
	MIME             string         `json:"mime"`
	ByteSize         int64          `json:"byteSize"`
	Width            int            `json:"width,omitempty"`
	Height           int            `json:"height,omitempty"`
	Preview          string         `json:"preview"`
	ThumbnailDataURL string         `json:"thumbnailDataUrl,omitempty"`
	Files            []string       `json:"files,omitempty"`
	SourceDevice     string         `json:"sourceDevice,omitempty"`
	SourceApp        string         `json:"sourceApp,omitempty"`
	Pinned           bool           `json:"pinned"`
	Deleted          bool           `json:"deleted"`
	SeenCount        int            `json:"seenCount"`
	CreatedAtMs      int64          `json:"createdAtMs"`
	LastSeenAtMs     int64          `json:"lastSeenAtMs"`
	SyncedAtMs       int64          `json:"syncedAtMs,omitempty"`
	RemoteID         string         `json:"remoteId,omitempty"`
	Materialized     bool           `json:"materialized"`
}

type itemDetailView struct {
	itemView
	Text          string `json:"text,omitempty"`
	TextTruncated bool   `json:"textTruncated,omitempty"`
	BlobPath      string `json:"blobPath,omitempty"`
}

func toItemView(item clipboard.Item) itemView {
	return itemView{
		ID:               item.ID,
		SHA256:           item.SHA256,
		Kind:             item.Kind,
		MIME:             item.MIME,
		ByteSize:         item.ByteSize,
		Width:            item.Width,
		Height:           item.Height,
		Preview:          item.Preview,
		ThumbnailDataURL: clipboard.ThumbnailDataURL(item.Thumbnail),
		Files:            item.Files,
		SourceDevice:     item.SourceDevice,
		SourceApp:        item.SourceApp,
		Pinned:           item.Pinned,
		Deleted:          item.Deleted,
		SeenCount:        item.SeenCount,
		CreatedAtMs:      item.CreatedAtMs,
		LastSeenAtMs:     item.LastSeenAtMs,
		SyncedAtMs:       item.SyncedAtMs,
		RemoteID:         item.RemoteID,
		Materialized:     item.Materialized,
	}
}

func (h *Handler) handleItemsCollection(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.handleListItems(w, r)
	case http.MethodPost:
		h.handleIngestItem(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
	}
}

func (h *Handler) handleListItems(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	filter := clipboard.ListFilter{
		Query: strings.TrimSpace(q.Get("q")),
	}
	if rawLimit := strings.TrimSpace(q.Get("limit")); rawLimit != "" {
		parsed, err := strconv.Atoi(rawLimit)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "invalid_limit", "limit 必须是正整数")
			return
		}
		filter.Limit = parsed
	}
	if rawBefore := strings.TrimSpace(q.Get("before")); rawBefore != "" {
		parsed, err := strconv.ParseInt(rawBefore, 10, 64)
		if err != nil || parsed < 0 {
			writeError(w, http.StatusBadRequest, "invalid_before", "before 必须是非负毫秒时间戳")
			return
		}
		filter.BeforeMs = parsed
	}
	if rawKind := strings.TrimSpace(q.Get("kind")); rawKind != "" {
		kind, err := clipboard.ParseKind(rawKind)
		if err != nil {
			writeError(w, http.StatusBadRequest, "clipboard_invalid_kind", "无效的剪贴板类型")
			return
		}
		filter.Kind = kind
	}
	if rawInc := strings.TrimSpace(q.Get("includeDeleted")); rawInc != "" {
		parsed, err := strconv.ParseBool(rawInc)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_include_deleted", "includeDeleted 必须是布尔值")
			return
		}
		filter.IncludeDeleted = parsed
	}

	items, err := h.Service.List(r.Context(), filter)
	if err != nil {
		h.writeDomainError(w, err)
		return
	}
	views := make([]itemView, 0, len(items))
	for _, item := range items {
		views = append(views, toItemView(item))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": views})
}

type ingestRequest struct {
	Kind       string   `json:"kind"`
	MIME       string   `json:"mime"`
	Text       string   `json:"text"`
	DataBase64 string   `json:"dataBase64"`
	Files      []string `json:"files"`
	Width      int      `json:"width"`
	Height     int      `json:"height"`
	SourceApp  string   `json:"sourceApp"`
	DeviceID   string   `json:"deviceId"`
}

func (h *Handler) handleIngestItem(w http.ResponseWriter, r *http.Request) {
	var body ingestRequest
	if err := h.decodeJSON(w, r, &body); err != nil {
		h.writeDecodeError(w, err)
		return
	}
	var kind clipboard.Kind
	if strings.TrimSpace(body.Kind) != "" {
		parsed, err := clipboard.ParseKind(body.Kind)
		if err != nil {
			writeError(w, http.StatusBadRequest, "clipboard_invalid_kind", "无效的剪贴板类型")
			return
		}
		kind = parsed
	}
	var data []byte
	if strings.TrimSpace(body.DataBase64) != "" {
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(body.DataBase64))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_base64", "dataBase64 格式无效")
			return
		}
		data = decoded
	}

	res, err := h.Service.Ingest(r.Context(), clipboard.IngestInput{
		Kind:         kind,
		MIME:         body.MIME,
		Text:         body.Text,
		Data:         data,
		Files:        body.Files,
		Width:        body.Width,
		Height:       body.Height,
		SourceDevice: body.DeviceID,
		SourceApp:    body.SourceApp,
	})
	if err != nil {
		h.writeDomainError(w, err)
		return
	}
	status := http.StatusCreated
	if res.Deduplicated {
		status = http.StatusOK
	}
	writeJSON(w, status, map[string]any{
		"item":         toItemView(res.Item),
		"deduplicated": res.Deduplicated,
	})
}

func (h *Handler) handleItemSubroute(w http.ResponseWriter, r *http.Request, tail string) {
	switch {
	case strings.HasSuffix(tail, "/content"):
		id := strings.TrimSuffix(tail, "/content")
		if id == "" || strings.Contains(id, "/") {
			writeError(w, http.StatusNotFound, "not_found", "没有这个剪贴板路由")
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
			return
		}
		h.handleItemContent(w, r, id)

	case strings.HasSuffix(tail, "/materialize"):
		id := strings.TrimSuffix(tail, "/materialize")
		if id == "" || strings.Contains(id, "/") {
			writeError(w, http.StatusNotFound, "not_found", "没有这个剪贴板路由")
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
			return
		}
		h.handleMaterializeItem(w, r, id)

	case strings.HasSuffix(tail, "/preview"):
		id := strings.TrimSuffix(tail, "/preview")
		if id == "" || strings.Contains(id, "/") {
			writeError(w, http.StatusNotFound, "not_found", "没有这个剪贴板路由")
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
			return
		}
		h.handleItemPreview(w, r, id)

	case strings.HasSuffix(tail, "/file"):
		id := strings.TrimSuffix(tail, "/file")
		if id == "" || strings.Contains(id, "/") {
			writeError(w, http.StatusNotFound, "not_found", "没有这个剪贴板路由")
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
			return
		}
		h.handleItemFile(w, r, id)

	case strings.HasSuffix(tail, "/pin"):
		id := strings.TrimSuffix(tail, "/pin")
		if id == "" || strings.Contains(id, "/") {
			writeError(w, http.StatusNotFound, "not_found", "没有这个剪贴板路由")
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
			return
		}
		h.handlePinItem(w, r, id)

	case strings.Contains(tail, "/"):
		writeError(w, http.StatusNotFound, "not_found", "没有这个剪贴板路由")

	default:
		switch r.Method {
		case http.MethodGet:
			h.handleGetItem(w, r, tail)
		case http.MethodDelete:
			h.handleDeleteItem(w, r, tail)
		default:
			w.Header().Set("Allow", "GET, DELETE")
			writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
		}
	}
}

func (h *Handler) handleGetItem(w http.ResponseWriter, r *http.Request, id string) {
	item, err := h.Service.Get(r.Context(), id)
	if err != nil {
		h.writeDomainError(w, err)
		return
	}
	detail := itemDetailView{
		itemView: toItemView(item),
		BlobPath: item.BlobPath,
	}
	if item.Kind == clipboard.KindText || item.Kind == clipboard.KindLink {
		text := item.Text
		if text == "" && item.BlobPath != "" {
			if content, readErr := h.Service.ReadContentForItem(r.Context(), item); readErr == nil {
				text = string(content.Data)
			}
		}
		detail.Text, detail.TextTruncated = truncateUTF8Bytes(text, clipboard.DetailTextPreviewBytes)
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": detail})
}

// safeItemContentType never reflects caller-supplied MIME verbatim: an SVG/HTML
// payload echoed same-origin would execute in the WebUI. Unknown types download.
func safeItemContentType(kind clipboard.Kind, mime string) (string, bool) {
	lower := strings.ToLower(strings.TrimSpace(strings.Split(mime, ";")[0]))
	switch kind {
	case clipboard.KindImage:
		switch lower {
		case "image/png", "image/jpeg", "image/gif", "image/webp":
			return lower, true
		}
		return "application/octet-stream", false
	case clipboard.KindText, clipboard.KindLink, clipboard.KindFile:
		return "text/plain; charset=utf-8", true
	default:
		return "application/octet-stream", false
	}
}

func (h *Handler) handleItemContent(w http.ResponseWriter, r *http.Request, id string) {
	item, err := h.Service.Get(r.Context(), id)
	if err != nil {
		h.writeDomainError(w, err)
		return
	}
	if !item.Materialized {
		_, ready, requestErr := h.Service.RequestMaterialization(r.Context(), id)
		if requestErr != nil {
			h.writeDomainError(w, requestErr)
			return
		}
		if !ready {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error":        map[string]string{"code": "clipboard_content_pending", "message": "正在从源设备获取内容"},
				"retryAfterMs": 800,
			})
			return
		}
		item, err = h.Service.Get(r.Context(), id)
		if err != nil {
			h.writeDomainError(w, err)
			return
		}
	}
	content, err := h.Service.ReadContentForItem(r.Context(), item)
	if err != nil {
		h.writeDomainError(w, err)
		return
	}
	contentType, inline := safeItemContentType(item.Kind, content.MIME)
	w.Header().Set("Content-Type", contentType)
	if inline {
		w.Header().Set("Content-Disposition", "inline")
	} else {
		w.Header().Set("Content-Disposition", `attachment; filename="clipboard-`+item.ID+`"`)
	}
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content.Data)
}

func (h *Handler) handleMaterializeItem(w http.ResponseWriter, r *http.Request, id string) {
	item, ready, err := h.Service.RequestMaterialization(r.Context(), id)
	if err != nil {
		h.writeDomainError(w, err)
		return
	}
	state := "pending"
	if ready {
		state = "ready"
	}
	writeJSON(w, http.StatusOK, map[string]any{"state": state, "item": toItemView(item)})
}

func (h *Handler) handleItemPreview(w http.ResponseWriter, r *http.Request, id string) {
	item, err := h.Service.Get(r.Context(), id)
	if err != nil {
		h.writeDomainError(w, err)
		return
	}
	if item.Kind != clipboard.KindFile {
		writeError(w, http.StatusBadRequest, "clipboard_preview_not_file", "只有文件引用支持文档预览")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"preview": clipboardpreview.Describe(item.Files)})
}

func (h *Handler) handleItemFile(w http.ResponseWriter, r *http.Request, id string) {
	item, err := h.Service.Get(r.Context(), id)
	if err != nil {
		h.writeDomainError(w, err)
		return
	}
	if item.Kind != clipboard.KindFile {
		writeError(w, http.StatusBadRequest, "clipboard_file_not_file", "只有文件引用支持文件流")
		return
	}
	index := 0
	if raw := strings.TrimSpace(r.URL.Query().Get("index")); raw != "" {
		parsed, parseErr := strconv.Atoi(raw)
		if parseErr != nil || parsed < 0 {
			writeError(w, http.StatusBadRequest, "invalid_index", "index 必须是非负整数")
			return
		}
		index = parsed
	}
	path, mime, ok := clipboardpreview.Streamable(item.Files, index)
	if !ok {
		writeError(w, http.StatusNotFound, "clipboard_file_unavailable", "文件不可用或类型不支持流式预览")
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeError(w, http.StatusNotFound, "clipboard_file_unavailable", "文件不可读")
		return
	}
	defer func() { _ = file.Close() }()
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Disposition", "inline")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = io.CopyN(w, file, clipboardpreview.MaxFileBytes)
}

func (h *Handler) handleDeleteItem(w http.ResponseWriter, r *http.Request, id string) {
	if err := h.Service.Delete(r.Context(), id); err != nil {
		h.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": true})
}

func (h *Handler) handlePinItem(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Pinned bool `json:"pinned"`
	}
	if err := h.decodeJSON(w, r, &body); err != nil {
		h.writeDecodeError(w, err)
		return
	}
	item, err := h.Service.SetPinned(r.Context(), id, body.Pinned)
	if err != nil {
		h.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": toItemView(item)})
}

func (h *Handler) handleSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		settings, err := h.Service.GetSettings(r.Context())
		if err != nil {
			h.writeDomainError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"settings": settings})
	case http.MethodPatch:
		var patch clipboard.SettingsPatch
		if err := h.decodeJSON(w, r, &patch); err != nil {
			h.writeDecodeError(w, err)
			return
		}
		settings, err := h.Service.UpdateSettings(r.Context(), patch)
		if err != nil {
			h.writeDomainError(w, err)
			return
		}
		if h.OnSettingsChanged != nil {
			h.OnSettingsChanged(settings)
		}
		writeJSON(w, http.StatusOK, map[string]any{"settings": settings})
	default:
		w.Header().Set("Allow", "GET, PATCH")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
	}
}

func (h *Handler) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
		return
	}
	status, err := h.Service.Status(r.Context())
	if err != nil {
		h.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// handleEvents streams clipboard change notifications so open HUDs can refresh
// in place instead of polling or reloading. Each event means "items changed";
// clients still fetch the authoritative list themselves.
func (h *Handler) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "clipboard_events_unsupported", "当前连接不支持实时事件")
		return
	}
	changes := h.Service.SubscribeChanges()
	defer h.Service.UnsubscribeChanges(changes)

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, "retry: 1500\nevent: ready\ndata: {}\n\n")
	flusher.Flush()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-changes:
			if _, err := io.WriteString(w, "event: clipboard\ndata: {}\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (h *Handler) handleServers(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
		return
	}
	if h.Servers == nil {
		writeJSON(w, http.StatusOK, map[string]any{"servers": []ServerProfileView{}})
		return
	}
	servers, err := h.Servers(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "clipboard_servers_failed", "读取远端服务器配置失败")
		return
	}
	if servers == nil {
		servers = []ServerProfileView{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"servers": servers})
}

func (h *Handler) handleSyncKey(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		key, fp, found, err := h.Service.GetSyncKey(r.Context())
		if err != nil {
			h.writeDomainError(w, err)
			return
		}
		if !found {
			writeError(w, http.StatusNotFound, "clipboard_sync_key_missing", "尚未配置同步密钥")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"key":         base64.StdEncoding.EncodeToString(key),
			"fingerprint": fp,
		})

	case http.MethodPost:
		var body struct {
			Key string `json:"key"`
		}
		if err := h.decodeJSON(w, r, &body); err != nil {
			h.writeDecodeError(w, err)
			return
		}
		rawKey, err := base64.StdEncoding.DecodeString(strings.TrimSpace(body.Key))
		if err != nil || len(rawKey) != clipboard.SyncKeyBytes {
			writeError(w, http.StatusBadRequest, "clipboard_invalid_sync_key", "同步密钥必须是 32 字节 base64")
			return
		}
		existingKey, fp, err := h.Service.SetSyncKeyIfAbsent(r.Context(), rawKey)
		if errors.Is(err, clipboard.ErrSyncKeyConflict) {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": map[string]string{
					"code":    "clipboard_sync_key_conflict",
					"message": "目标端已存在不同的同步密钥",
				},
				"key":         base64.StdEncoding.EncodeToString(existingKey),
				"fingerprint": fp,
			})
			return
		}
		if err != nil {
			h.writeDomainError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"key":         base64.StdEncoding.EncodeToString(existingKey),
			"fingerprint": fp,
		})

	default:
		w.Header().Set("Allow", "GET, POST")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
	}
}

// handleSyncTransfer accepts one parallel chunk of a file package. Chunks are
// authenticated by the sync key and only the complete archive upgrades the stub.
func (h *Handler) handleSyncTransfer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
		return
	}
	key, _, found, err := h.Service.GetSyncKey(r.Context())
	if err != nil {
		h.writeDomainError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "clipboard_sync_key_missing", "尚未配置同步密钥")
		return
	}
	var chunk clipboardruntime.TransferChunk
	if err := h.decodeJSON(w, r, &chunk); err != nil {
		h.writeDecodeError(w, err)
		return
	}
	if h.Transfers == nil {
		writeError(w, http.StatusServiceUnavailable, "clipboard_transfer_unavailable", "剪贴板传输未就绪")
		return
	}
	complete, err := h.Transfers.Accept(r.Context(), chunk, chunk.Sealed, key)
	if err != nil {
		if errors.Is(err, clipboardruntime.ErrSyncDecryptFailed) {
			writeError(w, http.StatusBadRequest, "clipboard_sync_decrypt_failed", "同步分片解密失败")
			return
		}
		h.writeDomainError(w, err)
		return
	}
	status := http.StatusAccepted
	if complete {
		status = http.StatusOK
	}
	writeJSON(w, status, map[string]any{"complete": complete})
}

func (h *Handler) handleSyncItems(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		h.handleSyncPush(w, r)
	case http.MethodGet:
		h.handleSyncPull(w, r)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
	}
}

func (h *Handler) handleSyncPush(w http.ResponseWriter, r *http.Request) {
	key, _, found, err := h.Service.GetSyncKey(r.Context())
	if err != nil {
		h.writeDomainError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "clipboard_sync_key_missing", "尚未配置同步密钥")
		return
	}
	var body struct {
		Items []clipboardruntime.SealedSyncItem `json:"items"`
	}
	if err := h.decodeJSON(w, r, &body); err != nil {
		h.writeDecodeError(w, err)
		return
	}
	if len(body.Items) > clipboard.SyncBatchMaxItems {
		writeError(w, http.StatusBadRequest, "clipboard_sync_batch_too_large", "单批最多 50 条同步条目")
		return
	}

	nowMs := time.Now().UnixMilli()
	ids := make(map[string]string, len(body.Items))
	dedup := make(map[string]bool, len(body.Items))
	for _, sealed := range body.Items {
		payload, openErr := clipboardruntime.OpenSyncPayload(key, sealed)
		if openErr != nil {
			writeError(w, http.StatusBadRequest, "clipboard_sync_decrypt_failed", "同步负载解密失败")
			return
		}
		var ingestInput clipboard.IngestInput
		var verifyErr error
		if payload.Lazy {
			ingestInput, verifyErr = clipboardruntime.VerifyMetadata(sealed.SHA256, payload, nowMs, "")
		} else {
			ingestInput, verifyErr = clipboardruntime.VerifyAndDecodePayload(sealed.SHA256, payload, nowMs)
		}
		if verifyErr != nil {
			h.writeDomainError(w, verifyErr)
			return
		}
		res, ingestErr := h.Service.Ingest(r.Context(), ingestInput)
		if ingestErr != nil {
			h.writeDomainError(w, ingestErr)
			return
		}
		shaKey := strings.ToLower(strings.TrimSpace(sealed.SHA256))
		if !payload.Lazy {
			_ = h.Service.ClearContentRequest(r.Context(), shaKey)
		}
		ids[shaKey] = res.Item.ID
		dedup[shaKey] = res.Deduplicated
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ids":   ids,
		"dedup": dedup,
	})
}

func (h *Handler) handleSyncPull(w http.ResponseWriter, r *http.Request) {
	key, _, found, err := h.Service.GetSyncKey(r.Context())
	if err != nil {
		h.writeDomainError(w, err)
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "clipboard_sync_key_missing", "尚未配置同步密钥")
		return
	}
	q := r.URL.Query()
	var sinceMs int64
	if rawSince := strings.TrimSpace(q.Get("since")); rawSince != "" {
		parsed, parseErr := strconv.ParseInt(rawSince, 10, 64)
		if parseErr != nil || parsed < 0 {
			writeError(w, http.StatusBadRequest, "invalid_since", "since 必须是非负毫秒时间戳")
			return
		}
		sinceMs = parsed
	}
	limit := clipboard.SyncBatchMaxItems
	if rawLimit := strings.TrimSpace(q.Get("limit")); rawLimit != "" {
		parsed, parseErr := strconv.Atoi(rawLimit)
		if parseErr != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "invalid_limit", "limit 必须是正整数")
			return
		}
		if parsed < limit {
			limit = parsed
		}
	}

	items, err := h.Service.ItemsSince(r.Context(), sinceMs, limit)
	if err != nil {
		h.writeDomainError(w, err)
		return
	}
	sealedItems := make([]clipboardruntime.SealedSyncItem, 0, len(items))
	cursor := sinceMs
	accBytes := 64
	for _, item := range items {
		payload, buildErr := clipboardruntime.BuildMetadataPayload(item)
		if buildErr != nil {
			// Skip un-buildable item (e.g. missing blob or >1 MiB text) without breaking pull.
			if item.LastSeenAtMs > cursor {
				cursor = item.LastSeenAtMs
			}
			continue
		}
		sealed, sealErr := clipboardruntime.SealSyncPayload(key, item.SHA256, payload)
		if sealErr != nil {
			h.writeDomainError(w, sealErr)
			return
		}
		sealedSize := len(sealed.Sealed) + len(sealed.SHA256) + 64
		if sealedSize > clipboard.MaxRequestBytes-1024 {
			// One oversized envelope must not make the whole pull undecodable.
			if item.LastSeenAtMs > cursor {
				cursor = item.LastSeenAtMs
			}
			continue
		}
		estSize := len(sealed.SHA256) + len(sealed.Sealed) + 40
		if len(sealedItems) > 0 && accBytes+estSize > clipboard.MaxRequestBytes {
			break
		}
		sealedItems = append(sealedItems, sealed)
		accBytes += estSize
		if item.LastSeenAtMs > cursor {
			cursor = item.LastSeenAtMs
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":  sealedItems,
		"cursor": cursor,
	})
}

func (h *Handler) handleSyncRequests(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
		return
	}
	limit := 50
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	shas, err := h.Service.ContentRequests(r.Context(), limit)
	if err != nil {
		h.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"shas": shas})
}

func (h *Handler) handleSyncRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
		return
	}
	if h.SyncRun == nil {
		writeError(w, http.StatusServiceUnavailable, "clipboard_sync_unavailable", "剪贴板同步器未就绪")
		return
	}
	if err := h.SyncRun(r.Context()); err != nil {
		writeError(w, http.StatusBadGateway, "clipboard_sync_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	maxBody := h.MaxBody
	if maxBody <= 0 {
		maxBody = clipboard.MaxRequestBytes
	}
	limited := http.MaxBytesReader(w, r.Body, maxBody)
	decoder := json.NewDecoder(limited)
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("trailing_json_data")
	}
	return nil
}

func (h *Handler) writeDecodeError(w http.ResponseWriter, err error) {
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) {
		writeError(w, http.StatusRequestEntityTooLarge, "clipboard_item_too_large", "请求体超过大小限制")
		return
	}
	writeError(w, http.StatusBadRequest, "invalid_json", "请求 JSON 格式无效")
}

func (h *Handler) writeDomainError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, clipboard.ErrNotFound):
		writeError(w, http.StatusNotFound, "clipboard_item_not_found", "剪贴板条目不存在")
	case errors.Is(err, clipboard.ErrEmptyContent):
		writeError(w, http.StatusBadRequest, "clipboard_empty_content", "剪贴板内容为空")
	case errors.Is(err, clipboard.ErrInvalidKind):
		writeError(w, http.StatusBadRequest, "clipboard_invalid_kind", "无效的剪贴板类型")
	case errors.Is(err, clipboard.ErrInvalidInput):
		writeError(w, http.StatusBadRequest, "clipboard_invalid_input", err.Error())
	case errors.Is(err, clipboard.ErrInvalidSyncKey):
		writeError(w, http.StatusBadRequest, "clipboard_invalid_sync_key", "同步密钥无效")
	case errors.Is(err, clipboard.ErrSyncKeyMissing):
		writeError(w, http.StatusNotFound, "clipboard_sync_key_missing", "尚未配置同步密钥")
	case errors.Is(err, clipboardruntime.ErrSyncDecryptFailed):
		writeError(w, http.StatusBadRequest, "clipboard_sync_decrypt_failed", "同步负载解密失败")
	case errors.Is(err, clipboardruntime.ErrSyncSHAMismatch):
		writeError(w, http.StatusBadRequest, "clipboard_sync_sha_mismatch", "同步内容校验和不匹配")
	case errors.Is(err, clipboard.ErrItemTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, "clipboard_item_too_large", "剪贴板条目超过大小限制")
	default:
		writeError(w, http.StatusInternalServerError, "clipboard_internal_error", "剪贴板内部错误")
	}
}

func truncateUTF8Bytes(s string, maxBytes int) (string, bool) {
	if len(s) <= maxBytes {
		return s, false
	}
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut], true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, code string, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}
