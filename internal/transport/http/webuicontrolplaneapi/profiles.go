package webuicontrolplaneapi

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	profilesKey  = "control-plane:profiles"
	storeVersion = 2
)

func nowMS() int64 { return time.Now().UnixMilli() }

func text(value any, max int) string {
	raw := ""
	if value != nil {
		raw = fmt.Sprint(value)
	}
	raw = strings.TrimSpace(raw)
	if max > 0 && len(raw) > max {
		raw = raw[:max]
	}
	return raw
}

func number(value any) int64 {
	switch typed := value.(type) {
	case float64:
		if typed > 0 && !math.IsInf(typed, 0) && !math.IsNaN(typed) {
			return int64(typed)
		}
	case int64:
		if typed > 0 {
			return typed
		}
	case int:
		if typed > 0 {
			return int64(typed)
		}
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err == nil && parsed > 0 && !math.IsInf(parsed, 0) {
			return int64(parsed)
		}
	}
	return 0
}

func positiveInt(value any) int {
	number := number(value)
	if number <= 0 {
		return 0
	}
	return int(number)
}

func boolValue(value any) bool {
	typed, ok := value.(bool)
	return ok && typed
}

func object(value any) map[string]any {
	typed, ok := value.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	return typed
}

func stringArray(value any, max int) []string {
	list, ok := value.([]any)
	if !ok {
		return []string{}
	}
	result := make([]string, 0, len(list))
	seen := map[string]struct{}{}
	for _, item := range list {
		text := text(item, max)
		if text == "" {
			continue
		}
		if _, exists := seen[text]; exists {
			continue
		}
		seen[text] = struct{}{}
		result = append(result, text)
	}
	return result
}

func normalizeEndpoint(value any) string {
	raw := strings.TrimRight(text(value, 2048), "/")
	if raw == "" {
		return ""
	}
	if !strings.HasPrefix(strings.ToLower(raw), "http://") && !strings.HasPrefix(strings.ToLower(raw), "https://") {
		raw = "https://" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return ""
	}
	parsed.Fragment = ""
	parsed.RawQuery = ""
	return strings.TrimRight(parsed.String(), "/")
}

func stableProfileID(endpoint string) string {
	hash := uint32(2166136261)
	for _, char := range endpoint {
		hash ^= uint32(char)
		hash *= 16777619
	}
	// JS Number.toString(36) 与 Go 的 36 进制一致（小写、无前缀）。
	return "cp-" + strings.ToLower(strconv.FormatUint(uint64(hash), 36))
}

func normalizeBroker(value any) map[string]any {
	source := object(value)
	brokerEndpoint := normalizeEndpoint(source["brokerEndpoint"])
	serverID := text(source["serverId"], 128)
	proxyEndpoint := normalizeEndpoint(source["proxyEndpoint"])
	if brokerEndpoint == "" || serverID == "" || proxyEndpoint == "" {
		return nil
	}
	return map[string]any{"brokerEndpoint": brokerEndpoint, "serverId": serverID, "proxyEndpoint": proxyEndpoint}
}

func normalizeTransport(value any) map[string]any {
	source := object(value)
	id := text(source["id"], 96)
	nodeID := text(source["nodeId"], 96)
	kind := text(source["kind"], 64)
	if id == "" || nodeID == "" || kind == "" {
		return nil
	}
	routeRole := text(source["routeRole"], 64)
	if routeRole == "" {
		routeRole = "data-plane"
	}
	trustLevel := text(source["trustLevel"], 64)
	if trustLevel == "" {
		trustLevel = "managed"
	}
	return map[string]any{
		"id": id, "nodeId": nodeID, "kind": kind,
		"status": text(source["status"], 32),
		"score":  number(source["score"]), "latencyMs": number(source["latencyMs"]),
		"lastError": text(source["lastError"], 512),
		"disabled":  boolValue(source["disabled"]),
		"managedBy": text(source["managedBy"], 64),
		"provider":  text(source["provider"], 64),
		"routeRole": routeRole, "trustLevel": trustLevel,
		"createdAt": number(source["createdAt"]), "updatedAt": number(source["updatedAt"]),
	}
}

func normalizeConnection(value any) map[string]any {
	source := object(value)
	status := text(source["status"], 32)
	if status == "" {
		status = "unknown"
	}
	return map[string]any{
		"status":        status,
		"transportKind": text(source["transportKind"], 64),
		"transportId":   text(source["transportId"], 96),
		"sessionId":     text(source["sessionId"], 160),
		"remoteAddress": text(source["remoteAddress"], 256),
		"connectedAt":   number(source["connectedAt"]),
		"lastSeenAt":    number(source["lastSeenAt"]),
	}
}

func normalizeNode(value any) map[string]any {
	source := object(value)
	id := text(source["id"], 96)
	if id == "" {
		return nil
	}
	transports := []map[string]any{}
	if list, ok := source["transports"].([]any); ok {
		for _, item := range list {
			if normalized := normalizeTransport(item); normalized != nil {
				transports = append(transports, normalized)
			}
		}
	}
	name := text(source["name"], 120)
	if name == "" {
		name = id
	}
	role := text(source["role"], 64)
	if role == "" {
		role = "node"
	}
	return map[string]any{
		"id": id, "name": name, "role": role,
		"endpointPolicy":      text(source["endpointPolicy"], 64),
		"preferredTransports": stringArray(source["preferredTransports"], 64),
		"capabilities":        stringArray(source["capabilities"], 96),
		"fingerprint":         text(source["fingerprint"], 160),
		"tags":                stringArray(source["tags"], 64),
		"disabled":            boolValue(source["disabled"]),
		"lastSeenAt":          number(source["lastSeenAt"]),
		"connection":          normalizeConnection(source["connection"]),
		"createdAt":           number(source["createdAt"]), "updatedAt": number(source["updatedAt"]),
		"transports": transports,
	}
}

func normalizeProfile(value any, previous map[string]any) (map[string]any, bool) {
	source := object(value)
	prior := previous
	if prior == nil {
		prior = map[string]any{}
	}
	endpoint := normalizeEndpoint(firstNonEmpty(source["endpoint"], prior["endpoint"]))
	if endpoint == "" {
		return nil, false
	}
	createdAt := number(firstNonEmpty(prior["createdAt"], source["createdAt"]))
	if createdAt == 0 {
		createdAt = nowMS()
	}
	updatedAt := number(source["updatedAt"])
	if updatedAt == 0 {
		updatedAt = nowMS()
	}
	nodes := []map[string]any{}
	if list, ok := source["nodes"].([]any); ok {
		for _, item := range list {
			if normalized := normalizeNode(item); normalized != nil {
				nodes = append(nodes, normalized)
			}
		}
	}
	state := strings.ToLower(text(source["state"], 32))
	if state != "ready" && state != "degraded" && state != "offline" {
		state = strings.ToLower(text(prior["state"], 32))
	}
	if state != "ready" && state != "degraded" && state != "offline" {
		state = "offline"
	}
	mode := strings.ToLower(text(firstNonEmpty(source["connectionMode"], prior["connectionMode"]), 32))
	if mode != "direct" && mode != "broker-proxy" {
		mode = "direct"
	}
	id := text(firstNonEmpty(source["id"], prior["id"]), 96)
	if id == "" {
		id = stableProfileID(endpoint)
	}
	name := text(firstNonEmpty(source["name"], prior["name"]), 120)
	if name == "" {
		name = endpoint
	}
	record := map[string]any{
		"id": id, "name": name, "endpoint": endpoint,
		"connectionMode":          mode,
		"state":                   state,
		"managementKey":           text(firstNonEmpty(source["managementKey"], prior["managementKey"]), 4096),
		"nodes":                   nodes,
		"nodeCount":               int(math.Max(float64(len(nodes)), float64(number(firstNonEmpty(source["nodeCount"], prior["nodeCount"]))))),
		"accountCount":            number(firstNonEmpty(source["accountCount"], prior["accountCount"])),
		"activeAccountCount":      number(firstNonEmpty(source["activeAccountCount"], prior["activeAccountCount"])),
		"schedulableAccountCount": number(firstNonEmpty(source["schedulableAccountCount"], prior["schedulableAccountCount"])),
		"sessionCount":            number(firstNonEmpty(source["sessionCount"], prior["sessionCount"])),
		"lastStatusSyncAt":        number(firstNonEmpty(source["lastStatusSyncAt"], prior["lastStatusSyncAt"])),
		"lastAccountsSyncAt":      number(firstNonEmpty(source["lastAccountsSyncAt"], prior["lastAccountsSyncAt"])),
		"lastSessionsSyncAt":      number(firstNonEmpty(source["lastSessionsSyncAt"], prior["lastSessionsSyncAt"])),
		"lastCheckedAt":           number(firstNonEmpty(source["lastCheckedAt"], prior["lastCheckedAt"])),
		"lastError":               text(source["lastError"], 512),
		"createdAt":               createdAt, "updatedAt": updatedAt,
	}
	broker := normalizeBroker(firstNonEmpty(source["broker"], prior["broker"]))
	if broker != nil {
		record["broker"] = broker
	}
	if descriptor, ok := firstNonEmpty(source["descriptor"], prior["descriptor"]).(map[string]any); ok {
		if service := text(descriptor["service"], 0); service != "" {
			record["descriptor"] = descriptor
		}
	}
	return record, true
}

func asAnyList(value any) []any {
	switch typed := value.(type) {
	case []any:
		return typed
	case []map[string]any:
		result := make([]any, 0, len(typed))
		for _, item := range typed {
			result = append(result, item)
		}
		return result
	default:
		return nil
	}
}

func firstNonEmpty(values ...any) any {
	for _, value := range values {
		if value == nil {
			continue
		}
		if text, ok := value.(string); ok && strings.TrimSpace(text) == "" {
			continue
		}
		return value
	}
	return nil
}

func normalizeStore(input any) map[string]any {
	source := object(input)
	profiles := []map[string]any{}
	if list := asAnyList(source["profiles"]); list != nil {
		for _, item := range list {
			normalized, ok := normalizeProfile(item, nil)
			if !ok {
				continue
			}
			filtered := make([]map[string]any, 0, len(profiles)+1)
			for _, existing := range profiles {
				if existing["id"] == normalized["id"] || existing["endpoint"] == normalized["endpoint"] {
					continue
				}
				filtered = append(filtered, existing)
			}
			profiles = append(filtered, normalized)
		}
	}
	sort.SliceStable(profiles, func(left, right int) bool {
		leftUpdated := number(profiles[left]["updatedAt"])
		rightUpdated := number(profiles[right]["updatedAt"])
		if leftUpdated != rightUpdated {
			return leftUpdated > rightUpdated
		}
		return text(profiles[left]["name"], 0) < text(profiles[right]["name"], 0)
	})
	activeProfileID := text(source["activeProfileId"], 96)
	active := ""
	for _, profile := range profiles {
		if profile["id"] == activeProfileID {
			active = activeProfileID
			break
		}
	}
	return map[string]any{"version": storeVersion, "activeProfileId": active, "profiles": profiles}
}

func decodeStore(raw string, found bool) (map[string]any, error) {
	if !found || strings.TrimSpace(raw) == "" {
		return normalizeStore(nil), nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, err
	}
	return normalizeStore(decoded), nil
}

func saveProfileInStore(store map[string]any, value any, options map[string]any) (map[string]any, map[string]any, error) {
	profiles := store["profiles"].([]map[string]any)
	probe := object(value)
	previous := map[string]any(nil)
	for _, profile := range profiles {
		if profile["id"] == text(probe["id"], 96) || profile["endpoint"] == normalizeEndpoint(probe["endpoint"]) {
			previous = profile
			break
		}
	}
	normalized, ok := normalizeProfile(value, previous)
	if !ok {
		return nil, nil, fmt.Errorf("invalid_control_plane_profile")
	}
	nextProfiles := make([]map[string]any, 0, len(profiles)+1)
	nextProfiles = append(nextProfiles, normalized)
	for _, profile := range profiles {
		if profile["id"] == normalized["id"] || profile["endpoint"] == normalized["endpoint"] {
			continue
		}
		nextProfiles = append(nextProfiles, profile)
	}
	activeProfileID := text(store["activeProfileId"], 96)
	if options["active"] == true {
		activeProfileID = normalized["id"].(string)
	} else if candidate := text(options["activeProfileId"], 96); candidate != "" {
		activeProfileID = candidate
	}
	next := normalizeStore(map[string]any{"profiles": nextProfiles, "activeProfileId": activeProfileID})
	for _, profile := range next["profiles"].([]map[string]any) {
		if profile["id"] == normalized["id"] {
			return next, profile, nil
		}
	}
	return next, normalized, nil
}

func setActiveInStore(store map[string]any, profileID string) map[string]any {
	id := text(profileID, 96)
	active := ""
	for _, profile := range store["profiles"].([]map[string]any) {
		if profile["id"] == id {
			active = id
			break
		}
	}
	return normalizeStore(map[string]any{"profiles": store["profiles"], "activeProfileId": active})
}

func removeFromStore(store map[string]any, profileID string) map[string]any {
	id := text(profileID, 96)
	profiles := []map[string]any{}
	for _, profile := range store["profiles"].([]map[string]any) {
		if profile["id"] == id {
			continue
		}
		profiles = append(profiles, profile)
	}
	active := store["activeProfileId"].(string)
	if active == id {
		active = ""
	}
	return normalizeStore(map[string]any{"profiles": profiles, "activeProfileId": active})
}
