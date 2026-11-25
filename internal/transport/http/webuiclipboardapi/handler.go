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
package webuiclipboardapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/madou1217/ai_home/application/clipboard"
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

// Handler serves clipboard management API requests.
type Handler struct {
	Authorizer        Authorizer
	Service           *clipboard.Service
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
		MaxBody:    clipboard.MaxRequestBytes,
	}, nil
}

// ServeHTTP dispatches clipboard routes under Path.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Service == nil {
		writeError(w, http.StatusServiceUnavailable, "clipboard_unavailable", "剪贴板服务未就绪")
		return
	}
	if h.Authorizer != nil && !h.Authorizer.Authorized(r) {
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
	case rest == "sync" || strings.HasPrefix(rest, "sync/"):
		writeError(w, http.StatusNotImplemented, "clipboard_sync_not_implemented", "剪贴板同步尚未启用")
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
			if content, readErr := h.Service.ReadContent(r.Context(), item); readErr == nil {
				text = string(content.Data)
			}
		}
		detail.Text, detail.TextTruncated = truncateUTF8Bytes(text, clipboard.DetailTextPreviewBytes)
	}
	writeJSON(w, http.StatusOK, map[string]any{"item": detail})
}

func (h *Handler) handleItemContent(w http.ResponseWriter, r *http.Request, id string) {
	item, err := h.Service.Get(r.Context(), id)
	if err != nil {
		h.writeDomainError(w, err)
		return
	}
	content, err := h.Service.ReadContent(r.Context(), item)
	if err != nil {
		h.writeDomainError(w, err)
		return
	}
	w.Header().Set("Content-Type", content.MIME)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content.Data)
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
