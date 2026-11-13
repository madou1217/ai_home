package webuitoolkitenvapi

import (
	"net/http"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

// remoteSummaryTTL 与 Node 远端汇总缓存一致：15s 内复用，过期同步重测。
const remoteSummaryTTL = 15 * time.Second

type remoteSummaryEntry struct {
	at      time.Time
	payload map[string]any
}

// summaryCache 是远端汇总缓存（按目标 key 分区）。本机探测很快，不缓存。
type summaryCache struct {
	mu      sync.Mutex
	entries map[string]remoteSummaryEntry
}

func (cache *summaryCache) get(key string) (map[string]any, bool) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	entry, ok := cache.entries[key]
	if !ok || time.Since(entry.at) >= remoteSummaryTTL {
		return nil, false
	}
	return entry.payload, true
}

func (cache *summaryCache) put(key string, payload map[string]any) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	cache.entries[key] = remoteSummaryEntry{at: time.Now(), payload: payload}
}

// handleEnvironments 是 GET /environments：本机与远端的探测口径共用同一套领域实现。
func (handler *Handler) handleEnvironments(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	target, err := handler.resolveTarget(request.Context(), request.URL.Query().Get("target"))
	if err != nil {
		writeTargetError(response, err)
		return
	}
	defer target.Close()
	host, err := target.Host(request.Context())
	if err != nil {
		writeTargetError(response, classifyRemoteError(err))
		return
	}
	summary := environment.BuildSummary(request.Context(), host, environment.BuildOptions{
		Platform: host.Platform,
		HomeDir:  host.HomeDir,
	})
	if target.Kind == "local" {
		writeJSON(response, http.StatusOK, summary)
		return
	}
	refresh := request.URL.Query().Get("refresh") == "1"
	if !refresh {
		if cached, ok := handler.summaries.get(target.Key); ok {
			writeJSON(response, http.StatusOK, cached)
			return
		}
	}
	payload := map[string]any{}
	encoded := mustJSON(summary)
	_ = decodeJSONMap(encoded, &payload)
	payload["target"] = map[string]any{
		"kind":     target.Kind,
		"id":       target.Key,
		"label":    target.Label,
		"platform": host.Platform,
	}
	payload["probedAt"] = time.Now().UnixMilli()
	handler.summaries.put(target.Key, payload)
	writeJSON(response, http.StatusOK, payload)
}
