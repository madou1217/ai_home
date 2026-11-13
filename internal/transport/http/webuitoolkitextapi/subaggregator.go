package webuitoolkitextapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
)

const (
	subAggMaxJSONBodyBytes   = 256 * 1024
	subAggMaxSourceBodyBytes = 3 * 1024 * 1024
)

var validHostHeaderPattern = regexp.MustCompile(`^[A-Za-z0-9.-]+(?::\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$`)

func (h *Handler) serveSubAggregator(w http.ResponseWriter, r *http.Request, path string) {
	if h.subAggregator == nil {
		writeError(w, http.StatusServiceUnavailable, "subscription_aggregator_unavailable", "订阅聚合器服务不可用")
		return
	}

	switch path {
	case SubAggregatorPath:
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		overview, err := h.subAggregator.GetOverview()
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, overview)

	case SubAggregatorLocalClientsPath:
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		local := subaggregator.IsLoopbackRemoteAddress(resolveRemoteAddr(r))
		writeJSON(w, http.StatusOK, h.subAggregator.DetectLocalClients(r.Context(), local))

	case SubAggregatorLocalSourcesPath:
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		if !subaggregator.IsLoopbackRemoteAddress(resolveRemoteAddr(r)) {
			writeJSON(w, http.StatusForbidden, map[string]any{
				"ok":    false,
				"error": "local_scan_requires_local_request",
			})
			return
		}
		scan, err := h.subAggregator.ScanLocalSources()
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, scan)

	case SubAggregatorLocalSourcesImportPath:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		if !subaggregator.IsLoopbackRemoteAddress(resolveRemoteAddr(r)) {
			writeJSON(w, http.StatusForbidden, map[string]any{
				"ok":    false,
				"error": "local_scan_requires_local_request",
			})
			return
		}
		body, ok := readSubAggBody(w, r, subAggMaxJSONBodyBytes)
		if !ok {
			return
		}
		res, err := h.subAggregator.ImportLocalSources(stringSliceField(body, "ids"))
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, res)

	case SubAggregatorSourcesSyncWatchPath:
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		h.serveSubAggregatorSyncWatch(w, r)

	case SubAggregatorRelayPath:
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		local := subaggregator.IsLoopbackRemoteAddress(resolveRemoteAddr(r))
		avail := h.subAggregator.RelayAvailability()
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":    true,
			"relay": avail,
			"local": local,
		})

	case SubAggregatorProfilesPath:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		body, ok := readSubAggBody(w, r, subAggMaxJSONBodyBytes)
		if !ok {
			return
		}
		profile, err := h.subAggregator.SaveProfile(body)
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "profile": profile})

	case SubAggregatorProfileNodesPath:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		body, ok := readSubAggBody(w, r, subAggMaxJSONBodyBytes)
		if !ok {
			return
		}
		nodes, err := h.subAggregator.PreviewNodes(body)
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		if nodes == nil {
			nodes = []subaggregator.PreviewNodeItem{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "nodes": nodes})

	case SubAggregatorProfileTestRoutePath:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		body, ok := readSubAggBody(w, r, subAggMaxJSONBodyBytes)
		if !ok {
			return
		}
		res, err := h.subAggregator.TestRoute(r.Context(), body)
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		unavail := res.Unavailable
		if unavail == nil {
			unavail = []string{}
		}
		groups := res.Groups
		if groups == nil {
			groups = []subaggregator.RouteGroupHop{}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":          true,
			"target":      res.Target,
			"rule":        res.Rule,
			"checked":     res.Checked,
			"unavailable": unavail,
			"groups":      groups,
			"end":         res.End,
		})

	case SubAggregatorProbePath:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		var input subaggregator.ProbeInput
		if err := readJSONTarget(w, r, &input, subAggMaxJSONBodyBytes); err != nil {
			writeSubAggDecodeError(w, err)
			return
		}
		res, err := h.subAggregator.Probe(r.Context(), input)
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, res)

	case SubAggregatorNodesParsePath:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		body, ok := readSubAggBody(w, r, subAggMaxSourceBodyBytes)
		if !ok {
			return
		}
		res, err := h.subAggregator.ParseNodes(stringValue(body["content"]))
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, res)

	case SubAggregatorNodesPath:
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		nodes, err := h.subAggregator.AllNodes()
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		if nodes == nil {
			nodes = []map[string]any{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "nodes": nodes})

	case SubAggregatorNodesChainPath:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		body, ok := readSubAggBody(w, r, subAggMaxJSONBodyBytes)
		if !ok {
			return
		}
		node, err := h.subAggregator.SetNodeChain(stringValue(body["nodeId"]), stringValue(body["chain"]))
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "node": node})

	case SubAggregatorSourcesPreviewPath:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		body, ok := readSubAggBody(w, r, subAggMaxSourceBodyBytes)
		if !ok {
			return
		}
		res, err := h.subAggregator.PreviewSource(stringValue(body["content"]))
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, res)

	case SubAggregatorSourcesPath:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		body, ok := readSubAggBody(w, r, subAggMaxSourceBodyBytes)
		if !ok {
			return
		}
		res, err := h.subAggregator.SaveSource(r.Context(), body)
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, res)

	case SubAggregatorSourcesSyncPath:
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		body, ok := readSubAggBody(w, r, subAggMaxJSONBodyBytes)
		if !ok {
			return
		}
		job, err := h.subAggregator.StartSourceSync(stringSliceField(body, "ids"))
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "job": job})

	default:
		switch {
		case strings.HasPrefix(path, SubAggregatorProfilesPath+"/"):
			h.serveSubAggregatorProfileItem(w, r, strings.TrimPrefix(path, SubAggregatorProfilesPath+"/"))
		case strings.HasPrefix(path, SubAggregatorSourcesPath+"/"):
			h.serveSubAggregatorSourceItem(w, r, strings.TrimPrefix(path, SubAggregatorSourcesPath+"/"))
		default:
			writeError(w, http.StatusNotFound, "not_found", "未找到订阅聚合器路由")
		}
	}
}

func (h *Handler) serveSubAggregatorProfileItem(w http.ResponseWriter, r *http.Request, rest string) {
	switch {
	case strings.HasSuffix(rest, "/token"):
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		id, ok := unescapeSegment(strings.TrimSuffix(rest, "/token"))
		if !ok {
			writeError(w, http.StatusNotFound, "aggregator_profile_not_found", "未找到聚合配置")
			return
		}
		profile, err := h.subAggregator.RotateToken(id)
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "profile": profile})

	case strings.HasSuffix(rest, "/preview"):
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		id, ok := unescapeSegment(strings.TrimSuffix(rest, "/preview"))
		if !ok {
			writeError(w, http.StatusNotFound, "aggregator_profile_not_found", "未找到聚合配置")
			return
		}
		q := r.URL.Query()
		format := q.Get("format")
		client := q.Get("client")
		view := q.Get("view")
		origin := resolveOrigin(r)
		remoteAddr := resolveRemoteAddr(r)
		relayRequested := q.Get("relay") == "1"
		if relayRequested {
			if _, err := h.subAggregator.StartRelay(r.Context(), id, format, client, remoteAddr, origin); err != nil {
				writeSubAggregatorError(w, err)
				return
			}
		}
		res, err := h.subAggregator.Preview(id, format, subaggregator.PreviewRequest{
			Client:        client,
			View:          view,
			Origin:        origin,
			Relay:         relayRequested,
			RemoteAddress: remoteAddr,
		})
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, res)

	case strings.HasSuffix(rest, "/import-links"):
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		id, ok := unescapeSegment(strings.TrimSuffix(rest, "/import-links"))
		if !ok {
			writeError(w, http.StatusNotFound, "aggregator_profile_not_found", "未找到聚合配置")
			return
		}
		links, err := h.subAggregator.ImportLinks(id, resolveOrigin(r))
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":              true,
			"origin":          links.Origin,
			"subscriptionUrl": links.SubscriptionURL,
			"clients":         links.Clients,
		})

	default:
		id, ok := unescapeSegment(rest)
		if !ok {
			writeError(w, http.StatusNotFound, "not_found", "未找到聚合配置路由")
			return
		}
		if !requireMethod(w, r, http.MethodDelete) {
			return
		}
		if err := h.subAggregator.DeleteProfile(id); err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func (h *Handler) serveSubAggregatorSourceItem(w http.ResponseWriter, r *http.Request, rest string) {
	switch {
	case strings.HasSuffix(rest, "/nodes"):
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		id, ok := unescapeSegment(strings.TrimSuffix(rest, "/nodes"))
		if !ok {
			writeError(w, http.StatusNotFound, "subscription_not_found", "未找到订阅源")
			return
		}
		nodes, err := h.subAggregator.SourceNodes(id)
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		if nodes == nil {
			nodes = []map[string]any{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "nodes": nodes})

	case strings.HasSuffix(rest, "/latency"):
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		id, ok := unescapeSegment(strings.TrimSuffix(rest, "/latency"))
		if !ok {
			writeError(w, http.StatusNotFound, "subscription_not_found", "未找到订阅源")
			return
		}
		body, bodyOK := readSubAggBody(w, r, subAggMaxJSONBodyBytes)
		if !bodyOK {
			return
		}
		fresh, _ := body["fresh"].(bool)
		results, err := h.subAggregator.MeasureLatency(r.Context(), id, fresh)
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "results": results})

	case strings.HasSuffix(rest, "/sync"):
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		id, ok := unescapeSegment(strings.TrimSuffix(rest, "/sync"))
		if !ok {
			writeError(w, http.StatusNotFound, "subscription_not_found", "未找到订阅源")
			return
		}
		res, err := h.subAggregator.StartSourceSyncOne(id)
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, res)

	case strings.HasSuffix(rest, "/enabled"):
		if !requireMethod(w, r, http.MethodPost) {
			return
		}
		id, ok := unescapeSegment(strings.TrimSuffix(rest, "/enabled"))
		if !ok {
			writeError(w, http.StatusNotFound, "subscription_not_found", "未找到订阅源")
			return
		}
		body, bodyOK := readSubAggBody(w, r, subAggMaxJSONBodyBytes)
		if !bodyOK {
			return
		}
		enabled, _ := body["enabled"].(bool)
		sub, err := h.subAggregator.SetSourceEnabled(id, enabled)
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "subscription": sub})

	default:
		id, ok := unescapeSegment(rest)
		if !ok {
			writeError(w, http.StatusNotFound, "not_found", "未找到订阅源路由")
			return
		}
		if !requireMethod(w, r, http.MethodDelete) {
			return
		}
		res, err := h.subAggregator.DeleteSource(id)
		if err != nil {
			writeSubAggregatorError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
	}
}

func (h *Handler) serveSubAggregatorSyncWatch(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "sse_unsupported", "当前连接不支持事件流")
		return
	}

	events := make(chan subaggregator.SyncEvent, 64)
	unsubscribe := h.subAggregator.OnSourceSyncChange(func(event subaggregator.SyncEvent) {
		select {
		case events <- event:
		default:
		}
	})
	defer unsubscribe()

	headers := w.Header()
	headers.Set("Content-Type", "text/event-stream; charset=utf-8")
	headers.Set("Cache-Control", "no-cache")
	headers.Set("Connection", "keep-alive")
	headers.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	snap := h.subAggregator.ListSourceSyncJobs()
	if snap.Sources == nil {
		snap.Sources = map[string]subaggregator.SyncSourceState{}
	}
	if snap.Jobs == nil {
		snap.Jobs = []subaggregator.SyncJobView{}
	}
	snapshotPayload := map[string]any{
		"type":    "snapshot",
		"sources": snap.Sources,
		"jobs":    snap.Jobs,
	}
	if !writeSSEJSON(w, flusher, snapshotPayload) {
		return
	}

	ticker := time.NewTicker(h.heartbeatInterval)
	defer ticker.Stop()

	ctxDone := r.Context().Done()
	for {
		select {
		case <-ctxDone:
			return
		case evt, open := <-events:
			if !open {
				return
			}
			if !writeSSEJSON(w, flusher, evt) {
				return
			}
		case <-ticker.C:
			if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func writeSSEJSON(w http.ResponseWriter, flusher http.Flusher, payload any) bool {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return false
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", encoded); err != nil {
		return false
	}
	flusher.Flush()
	return true
}

func readSubAggBody(w http.ResponseWriter, r *http.Request, maxBytes int64) (map[string]any, bool) {
	body, err := readJSONMap(w, r, maxBytes)
	if err == nil {
		return body, true
	}
	writeSubAggDecodeError(w, err)
	return nil, false
}

func writeSubAggDecodeError(w http.ResponseWriter, err error) {
	if errors.Is(err, errBodyTooLarge) {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
			"ok":    false,
			"error": "request_body_too_large",
		})
		return
	}
	writeJSON(w, http.StatusBadRequest, map[string]any{
		"ok":    false,
		"error": "invalid_json_body",
	})
}

func writeSubAggregatorError(w http.ResponseWriter, err error) {
	if de, ok := subaggregator.AsDomainError(err); ok {
		payload := map[string]any{
			"ok":    false,
			"error": de.Code,
		}
		if de.Message != "" && de.Message != de.Code {
			payload["message"] = de.Message
		}
		writeJSON(w, subaggregator.MapErrorStatus(de.Code), payload)
		return
	}
	code := "subscription_aggregator_failed"
	msg := err.Error()
	payload := map[string]any{
		"ok":    false,
		"error": code,
	}
	if msg != "" && msg != code {
		payload["message"] = msg
	}
	writeJSON(w, subaggregator.MapErrorStatus(code), payload)
}

func resolveRemoteAddr(r *http.Request) string {
	if r == nil {
		return ""
	}
	if r.URL != nil {
		if explicit := strings.TrimSpace(r.URL.Query().Get("remoteAddr")); explicit != "" {
			return explicit
		}
	}
	return r.RemoteAddr
}

func resolveOrigin(r *http.Request) string {
	if r == nil {
		return ""
	}
	if r.URL != nil {
		if explicit := strings.TrimSpace(r.URL.Query().Get("origin")); explicit != "" {
			return explicit
		}
	}
	host := firstHeaderToken(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = firstHeaderToken(r.Host)
	}
	if !validHostHeaderPattern.MatchString(host) {
		return ""
	}
	proto := strings.ToLower(firstHeaderToken(r.Header.Get("X-Forwarded-Proto")))
	if proto != "http" && proto != "https" {
		if r.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	return proto + "://" + host
}

func firstHeaderToken(raw string) string {
	idx := strings.IndexByte(raw, ',')
	if idx >= 0 {
		raw = raw[:idx]
	}
	return strings.TrimSpace(raw)
}

func stringValue(raw any) string {
	if s, ok := raw.(string); ok {
		return s
	}
	return ""
}

func stringSliceField(m map[string]any, key string) []string {
	raw, exists := m[key]
	if !exists || raw == nil {
		return nil
	}
	arr, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			out = append(out, s)
		} else if item != nil {
			out = append(out, fmt.Sprint(item))
		}
	}
	return out
}
