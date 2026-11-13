package sessionactivity

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// DefaultCodebuddyLimitInterval 是 CodeBuddy 429 冷却观察器的默认扫描周期。
	DefaultCodebuddyLimitInterval = 60 * time.Second
	// MinCodebuddyLimitInterval 是扫描周期下限。
	MinCodebuddyLimitInterval = 15 * time.Second

	codebuddySharedLogDirName      = ".codebuddy"
	codebuddySharedLogDays         = 2
	codebuddyWriteTimeToleranceMS  = 5000
	codebuddyLogCacheLimit         = 8
)

var (
	codebuddyFamilyProviders = []string{"codebuddy", "codebuddycn", "workbuddy", "workbuddycn"}

	codebuddyConfigDirByProvider = map[string]string{
		"codebuddy":   ".codebuddy",
		"codebuddycn": ".codebuddy-cn",
		"workbuddy":   ".workbuddy-ai",
		"workbuddycn": ".workbuddy",
	}

	codebuddyProviderByConfigDir = map[string]string{
		".codebuddy":    "codebuddy",
		".codebuddy-cn": "codebuddycn",
		".workbuddy-ai": "workbuddy",
		".workbuddy":    "workbuddycn",
	}

	codebuddySessionRootsByProvider = map[string][]string{
		"codebuddy":   {".codebuddy", ".workbuddy-ai"},
		"workbuddy":   {".workbuddy-ai", ".codebuddy"},
		"codebuddycn": {".codebuddy-cn", ".workbuddy"},
		"workbuddycn": {".workbuddy", ".codebuddy-cn"},
	}

	codebuddyIssuers = map[string][]string{
		"https://www.codebuddy.ai/auth/realms/copilot":   {"codebuddy"},
		"https://www.workbuddy.ai/auth/realms/copilot":   {"workbuddy"},
		"https://www.workbuddy.cn/auth/realms/copilot":   {"codebuddycn", "workbuddycn"},
		"https://www.codebuddy.cn/auth/realms/copilot":   {"codebuddycn", "workbuddycn"},
		"https://copilot.tencent.com/auth/realms/copilot": {"codebuddycn", "workbuddycn"},
	}

	resetAtPattern       = regexp.MustCompile(`(?i)reset(?:s)?\s+at\s+(\d{4})-(\d{2})-(\d{2})[ t](\d{2}):(\d{2})(?::(\d{2}))?\s*(?:(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?|utc|gmt|z)?`)
	resetAtZhPattern     = regexp.MustCompile(`(?i)(\d{4})-(\d{2})-(\d{2})[ t](\d{2}):(\d{2})(?::(\d{2}))?\s*(?:(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?|utc|gmt|z)?\s*(?:重置|恢复|解禁|到期)`)
	bareTimestampPattern = regexp.MustCompile(`(?i)(\d{4})-(\d{2})-(\d{2})[ t](\d{2}):(\d{2})(?::(\d{2}))?\s*(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?`)
	timezoneTokenPattern = regexp.MustCompile(`(?i)(?:^|[^a-z])(?:utc|gmt|z)(?:[^a-z]|$)`)
	creditsExhaustedRe   = regexp.MustCompile(`(?i)credits?\s+(?:are\s+|have\s+been\s+)?exhausted`)

	codebuddySessionIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
	codebuddyUIDRe       = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	codebuddyReqIDRe     = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)
	cbWriteLineRe        = regexp.MustCompile(`^\[([^\]]+)\] \[Info\] \[pid=(\d+)\] \[addHistory\] START sessionId=([A-Za-z0-9][A-Za-z0-9_-]{0,127}), storeId=[^,]*, types=\[([^\]]*)\], input=\[(.*)\]$`)
	cbInputEntryRe       = regexp.MustCompile(`^\{type: ([A-Za-z_][A-Za-z_-]*), id: ([A-Za-z0-9][A-Za-z0-9_-]{0,127})\}$`)
	cbUserIDLineRe       = regexp.MustCompile(`^\[[^\]]+\] \[[^\]]+\] \[pid=(\d+)\][^\n]*?["'](?:userId|user_id|x-user-id)["']\s*:\s*["']([^"']+)["']`)
	cbLogDayDirRe        = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	cbISOStampRe         = regexp.MustCompile(`^(\d{4})/(\d{1,2})/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})\.(\d{1,3})$`)
	cbUSStampRe          = regexp.MustCompile(`^(\d{1,2})/(\d{1,2})/(\d{4}), (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)\.(\d{1,3})$`)
)

// ResetAtMatch 表示从限流文本解析出的恢复时刻匹配信息。
type ResetAtMatch struct {
	MS          int64
	Length      int
	Text        string
	AtEnd       bool
	HasTimezone bool
	HasVerb     bool
	Complete    bool
}

// ParseResetAtTimestampMatch 按英文/中文/裸时间戳三种模式匹配恢复时刻并取最长结果。
func ParseResetAtTimestampMatch(text string, allowBare bool) (ResetAtMatch, bool) {
	var candidates []ResetAtMatch
	consider := func(indices []int, hasVerb bool) {
		if len(indices) == 0 {
			return
		}
		fullStart, fullEnd := indices[0], indices[1]
		matchedText := text[fullStart:fullEnd]
		sub := extractSubmatches(text, indices)
		ms := timestampMatchToMS(sub)
		if ms <= 0 {
			return
		}
		hasTimezone := timezoneTokenPattern.MatchString(matchedText)
		atEnd := strings.TrimSpace(text[fullEnd:]) == ""
		candidates = append(candidates, ResetAtMatch{
			MS:          ms,
			Length:      len(matchedText),
			Text:        matchedText,
			AtEnd:       atEnd,
			HasTimezone: hasTimezone,
			HasVerb:     hasVerb,
			Complete:    hasTimezone || hasVerb || !atEnd,
		})
	}
	consider(resetAtPattern.FindStringSubmatchIndex(text), false)
	consider(resetAtZhPattern.FindStringSubmatchIndex(text), true)
	if allowBare {
		consider(bareTimestampPattern.FindStringSubmatchIndex(text), false)
	}
	if len(candidates) == 0 {
		return ResetAtMatch{}, false
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].Length > candidates[j].Length
	})
	return candidates[0], true
}

// ParseResetAtTimestampMS 解析文本中的恢复时刻 epoch 毫秒，无匹配返回 0。
func ParseResetAtTimestampMS(text string, allowBare bool) int64 {
	match, ok := ParseResetAtTimestampMatch(text, allowBare)
	if !ok {
		return 0
	}
	return match.MS
}

func extractSubmatches(text string, indices []int) []string {
	count := len(indices) / 2
	out := make([]string, count)
	for i := 0; i < count; i++ {
		s, e := indices[i*2], indices[i*2+1]
		if s >= 0 && e >= s {
			out[i] = text[s:e]
		}
	}
	return out
}

func timestampMatchToMS(sub []string) int64 {
	if len(sub) < 6 {
		return 0
	}
	year, errY := strconv.Atoi(sub[1])
	month, errMo := strconv.Atoi(sub[2])
	day, errD := strconv.Atoi(sub[3])
	hour, errH := strconv.Atoi(sub[4])
	minute, errMi := strconv.Atoi(sub[5])
	sec := 0
	if len(sub) > 6 && sub[6] != "" {
		sec, _ = strconv.Atoi(sub[6])
	}
	if errY != nil || errMo != nil || errD != nil || errH != nil || errMi != nil {
		return 0
	}
	if month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || sec > 59 {
		return 0
	}
	t := time.Date(year, time.Month(month), day, hour, minute, sec, 0, time.UTC)
	utcMS := t.UnixMilli()
	var offsetMinutes int64
	if len(sub) > 8 && sub[7] != "" && sub[8] != "" {
		offH, _ := strconv.Atoi(sub[8])
		offM := 0
		if len(sub) > 9 && sub[9] != "" {
			offM, _ = strconv.Atoi(sub[9])
		}
		sign := int64(1)
		if sub[7] == "-" {
			sign = -1
		}
		offsetMinutes = sign * int64(offH*60+offM)
	}
	return utcMS - offsetMinutes*60*1000
}

// IsCreditsExhaustedMessage 识别 CodeBuddy 国际站无恢复时刻的额度硬耗尽错误。
func IsCreditsExhaustedMessage(message string) bool {
	text := strings.ToLower(strings.TrimSpace(message))
	if !creditsExhaustedRe.MatchString(text) {
		return false
	}
	return strings.Contains(text, "add-on packs") ||
		strings.Contains(text, "purchase") ||
		strings.Contains(text, "profile/usage")
}

// SessionLimitObservation 表示从一行会话日志解析出的 429 冷却事件。
type SessionLimitObservation struct {
	ID             string
	Message        string
	Code           any
	RequestID      string
	ResetAtMS      int64
	HardExhaustion bool
	AtMS           int64
}

// SessionLimitLineResult 是单行 CodeBuddy jsonl 的解析结果。
type SessionLimitLineResult struct {
	Model string
	Limit *SessionLimitObservation
}

// ReadSessionLimitLine 解析单行 CodeBuddy jsonl 为 429 冷却观察或模型线索。
func ReadSessionLimitLine(line string) *SessionLimitLineResult {
	var raw map[string]any
	if json.Unmarshal([]byte(line), &raw) != nil || len(raw) == 0 {
		return nil
	}
	data, _ := raw["providerData"].(map[string]any)
	var model string
	if data != nil {
		if m, ok := data["model"].(string); ok {
			model = strings.TrimSpace(m)
		}
	}
	var errMap map[string]any
	if data != nil {
		errMap, _ = data["error"].(map[string]any)
	}
	statusCode := 0
	if errMap != nil {
		switch v := errMap["status"].(type) {
		case float64:
			statusCode = int(v)
		case int:
			statusCode = v
		case string:
			statusCode, _ = strconv.Atoi(strings.TrimSpace(v))
		}
	}
	if errMap == nil || statusCode != 429 {
		if model == "" {
			return nil
		}
		return &SessionLimitLineResult{Model: model}
	}
	msg, _ := errMap["message"].(string)
	msg = strings.TrimSpace(msg)
	resetAtMS := ParseResetAtTimestampMS(msg, false)
	hardExhaustion := resetAtMS == 0 && IsCreditsExhaustedMessage(msg)
	if resetAtMS == 0 && !hardExhaustion {
		return nil
	}
	id, _ := raw["id"].(string)
	reqID, _ := errMap["requestID"].(string)
	if strings.TrimSpace(reqID) == "" {
		reqID, _ = errMap["requestId"].(string)
	}
	return &SessionLimitLineResult{
		Model: model,
		Limit: &SessionLimitObservation{
			ID:             strings.TrimSpace(id),
			Message:        msg,
			Code:           errMap["code"],
			RequestID:      strings.TrimSpace(reqID),
			ResetAtMS:      resetAtMS,
			HardExhaustion: hardExhaustion,
			AtMS:           parseTimestampMS(raw["timestamp"]),
		},
	}
}

// CodebuddyUsageFile 表示按 dev:ino 去重后的 CodeBuddy 原生会话文件。
type CodebuddyUsageFile struct {
	FilePath       string
	Provider       string
	ProjectsRoot   string
	SessionID      string
	ProjectDirName string
}

// DiscoverCodebuddyUsageFiles 发现宿主 CodeBuddy 家族 projects/*.jsonl 并按 dev:ino 去重。
func DiscoverCodebuddyUsageFiles(hostHomeDir string, providers []string, sessionID string) []CodebuddyUsageFile {
	sidFilter := strings.TrimSpace(sessionID)
	if sidFilter != "" && !codebuddySessionIDRe.MatchString(sidFilter) {
		return nil
	}
	host := strings.TrimSpace(hostHomeDir)
	if host == "" {
		return nil
	}
	if len(providers) == 0 {
		providers = codebuddyFamilyProviders
	}
	nativeHome := resolvePhysicalPathStr(host)

	type rootEntry struct {
		root     string
		provider string
	}
	roots := make(map[string]rootEntry)
	for _, prov := range providers {
		for _, dir := range codebuddySessionRootsByProvider[strings.ToLower(strings.TrimSpace(prov))] {
			root := filepath.Join(host, dir, "projects")
			phys := resolvePhysicalPathStr(root)
			ownerProv := codebuddyProviderByConfigDir[dir]
			if ownerProv == "" {
				ownerProv = prov
			}
			if _, exists := roots[phys]; !exists || phys == filepath.Join(nativeHome, dir, "projects") {
				roots[phys] = rootEntry{root: root, provider: ownerProv}
			}
		}
	}

	physKeys := make([]string, 0, len(roots))
	for k := range roots {
		physKeys = append(physKeys, k)
	}
	sort.Strings(physKeys)

	identities := make(map[string]struct{})
	files := make(map[string]CodebuddyUsageFile)
	for _, k := range physKeys {
		entry := roots[k]
		projDirs, err := os.ReadDir(entry.root)
		if err != nil {
			continue
		}
		for _, pd := range projDirs {
			if !pd.IsDir() {
				continue
			}
			pDir := filepath.Join(entry.root, pd.Name())
			var names []string
			if sidFilter != "" {
				names = []string{sidFilter + ".jsonl"}
			} else {
				entries, rErr := os.ReadDir(pDir)
				if rErr != nil {
					continue
				}
				for _, e := range entries {
					names = append(names, e.Name())
				}
			}
			for _, name := range names {
				if !strings.HasSuffix(name, ".jsonl") {
					continue
				}
				sid := strings.TrimSuffix(name, ".jsonl")
				if !codebuddySessionIDRe.MatchString(sid) {
					continue
				}
				fp := filepath.Join(pDir, name)
				info, stErr := os.Stat(fp)
				if stErr != nil || !info.Mode().IsRegular() {
					continue
				}
				phys := resolvePhysicalPathStr(fp)
				identity := phys
				if st, ok := info.Sys().(*syscall.Stat_t); ok && st.Ino > 0 {
					identity = fmt.Sprintf("%d:%d", st.Dev, st.Ino)
				}
				if _, dup := identities[identity]; dup {
					continue
				}
				identities[identity] = struct{}{}
				files[phys] = CodebuddyUsageFile{
					FilePath:       phys,
					Provider:       entry.provider,
					ProjectsRoot:   entry.root,
					SessionID:      sid,
					ProjectDirName: pd.Name(),
				}
			}
		}
	}

	keys := make([]string, 0, len(files))
	for k := range files {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]CodebuddyUsageFile, 0, len(keys))
	for _, k := range keys {
		out = append(out, files[k])
	}
	return out
}

func resolvePhysicalPathStr(target string) string {
	resolved, err := filepath.EvalSymlinks(target)
	if err == nil && resolved != "" {
		return resolved
	}
	abs, absErr := filepath.Abs(target)
	if absErr == nil {
		return abs
	}
	return target
}

func resolveAccountRuntimeDir(aiHomeDir, provider, accountRef string) string {
	root := strings.TrimSpace(aiHomeDir)
	prov := strings.ToLower(strings.TrimSpace(provider))
	ref := strings.TrimSpace(accountRef)
	if root == "" || prov == "" || !IsAccountRef(ref) {
		return ""
	}
	return filepath.Join(root, "run", "auth-projections", prov, ref)
}

func resolveAccountCLIRuntimeDir(aiHomeDir, provider, accountRef string) string {
	base := resolveAccountRuntimeDir(aiHomeDir, provider, accountRef)
	if base == "" {
		return ""
	}
	prov := strings.ToLower(strings.TrimSpace(provider))
	if prov == "workbuddy" || prov == "workbuddycn" {
		if filepath.Base(base) == "cli-home" {
			return base
		}
		return filepath.Join(base, "cli-home")
	}
	return base
}

// FindRequestModelInCliLogs 根据 requestId 反查当轮或前一天 CLI 日志里的模型名。
func FindRequestModelInCliLogs(
	aiHomeDir, hostHomeDir, provider, accountRef, requestID string,
	atMS int64,
	now time.Time,
) string {
	prov := strings.ToLower(strings.TrimSpace(provider))
	reqID := strings.TrimSpace(requestID)
	cfgDir, ok := codebuddyConfigDirByProvider[prov]
	if !ok || reqID == "" || !codebuddyReqIDRe.MatchString(reqID) {
		return ""
	}
	if atMS > 0 {
		now = time.UnixMilli(atMS)
	} else if now.IsZero() {
		now = time.Now()
	}
	needle := "requestId=" + reqID
	pat := regexp.MustCompile(`Sending request: [^\n]*?model=([A-Za-z0-9._:/-]+), requestId=` + regexp.QuoteMeta(reqID) + `\b`)

	day0 := now.Format("2006-01-02")
	day1 := now.Add(-24 * time.Hour).Format("2006-01-02")
	days := []string{day0}
	if day1 != day0 {
		days = append(days, day1)
	}

	type location struct {
		home      string
		configDir string
	}
	seenHome := make(map[string]struct{})
	var locations []location
	for _, home := range []string{
		resolveAccountRuntimeDir(aiHomeDir, prov, accountRef),
		resolveAccountCLIRuntimeDir(aiHomeDir, prov, accountRef),
	} {
		if home == "" {
			continue
		}
		if _, dup := seenHome[home]; dup {
			continue
		}
		seenHome[home] = struct{}{}
		locations = append(locations, location{home: home, configDir: cfgDir})
	}
	if (prov == "codebuddy" || prov == "codebuddycn") && strings.TrimSpace(hostHomeDir) != "" {
		locations = append(locations, location{home: strings.TrimSpace(hostHomeDir), configDir: codebuddySharedLogDirName})
	}

	for _, loc := range locations {
		for _, day := range days {
			dir := filepath.Join(loc.home, loc.configDir, "logs", day)
			entries, err := os.ReadDir(dir)
			if err != nil {
				continue
			}
			for _, e := range entries {
				if e.IsDir() || !strings.HasSuffix(e.Name(), ".log") {
					continue
				}
				raw, rErr := os.ReadFile(filepath.Join(dir, e.Name()))
				if rErr != nil {
					continue
				}
				text := string(raw)
				if !strings.Contains(text, needle) {
					continue
				}
				if match := pat.FindStringSubmatch(text); len(match) == 2 {
					return match[1]
				}
			}
		}
	}
	return ""
}

// CodebuddyAccountIdentity 描述一个 CodeBuddy 家族账号的 UID 归属信息。
type CodebuddyAccountIdentity struct {
	Provider   string
	AccountRef string
	UID        string
}

// LoadCodebuddyAccountIdentities 从 aih.db / app-state.db 读取 CodeBuddy 家族账号及其原生 UID。
func LoadCodebuddyAccountIdentities(ctx context.Context, aiHomeDir string) []CodebuddyAccountIdentity {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	byKey := make(map[string]CodebuddyAccountIdentity)

	aihDBPath := filepath.Join(root, "aih.db")
	if info, err := os.Stat(aihDBPath); err == nil && info.Mode().IsRegular() {
		if db, err := sql.Open("sqlite", "file:"+aihDBPath+"?mode=ro&_busy_timeout=5000"); err == nil {
			rows, qErr := db.QueryContext(ctx, `
				SELECT a.provider_id, a.account_ref, COALESCE(c.credential_json, '')
				FROM accounts a
				LEFT JOIN account_credentials c ON c.account_ref = a.account_ref
				WHERE a.provider_id IN ('codebuddy','codebuddycn','workbuddy','workbuddycn')
			`)
			if qErr == nil {
				for rows.Next() {
					var prov, ref, payload string
					if rows.Scan(&prov, &ref, &payload) == nil {
						prov = strings.ToLower(strings.TrimSpace(prov))
						ref = strings.TrimSpace(ref)
						if !IsAccountRef(ref) {
							continue
						}
						uid, _, ok := inspectCodebuddyCredentialPayload([]byte(payload), prov)
						if !ok {
							uid = ""
						}
						byKey[prov+":"+ref] = CodebuddyAccountIdentity{
							Provider:   prov,
							AccountRef: ref,
							UID:        uid,
						}
					}
				}
				_ = rows.Close()
			}
			_ = db.Close()
		}
	}

	if appStatePath, err := appstate.DatabasePath(root); err == nil {
		if db, err := appstate.OpenReadOnly(ctx, appStatePath); err == nil {
			rows, qErr := db.QueryContext(ctx, `
				SELECT r.provider, r.account_ref, COALESCE(c.native_auth_json, '')
				FROM account_refs r
				LEFT JOIN account_credentials c ON c.account_ref = r.account_ref
				WHERE r.provider IN ('codebuddy','codebuddycn','workbuddy','workbuddycn')
			`)
			if qErr == nil {
				for rows.Next() {
					var prov, ref, payload string
					if rows.Scan(&prov, &ref, &payload) == nil {
						prov = strings.ToLower(strings.TrimSpace(prov))
						ref = strings.TrimSpace(ref)
						if !IsAccountRef(ref) {
							continue
						}
						key := prov + ":" + ref
						if existing, exists := byKey[key]; exists && existing.UID != "" {
							continue
						}
						uid, _, ok := inspectCodebuddyCredentialPayload([]byte(payload), prov)
						if !ok {
							uid = ""
						}
						byKey[key] = CodebuddyAccountIdentity{
							Provider:   prov,
							AccountRef: ref,
							UID:        uid,
						}
					}
				}
				_ = rows.Close()
			}
			_ = db.Close()
		}
	}

	keys := make([]string, 0, len(byKey))
	for k := range byKey {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]CodebuddyAccountIdentity, 0, len(keys))
	for _, k := range keys {
		out = append(out, byKey[k])
	}
	return out
}

func inspectCodebuddyCredentialPayload(raw []byte, expectedProvider string) (uid, domain string, ok bool) {
	if len(raw) == 0 || len(raw) > 1024*1024 {
		return "", "", false
	}
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return "", "", false
	}
	if inner, has := doc["native_auth_json"].(map[string]any); has && inner != nil {
		doc = inner
	} else if innerRaw, has := doc["native_auth_json"].(string); has && strings.TrimSpace(innerRaw) != "" {
		var parsed map[string]any
		if json.Unmarshal([]byte(innerRaw), &parsed) == nil && parsed != nil {
			doc = parsed
		}
	}
	if creds, has := doc["credentials"].(map[string]any); has && creds != nil {
		doc = creds
	}
	authMap, _ := doc["auth"].(map[string]any)
	acctMap, _ := doc["account"].(map[string]any)
	if authMap == nil || acctMap == nil {
		return "", "", false
	}
	accessToken, _ := authMap["accessToken"].(string)
	if accessToken == "" {
		accessToken, _ = authMap["access_token"].(string)
	}
	refreshToken, _ := authMap["refreshToken"].(string)
	if refreshToken == "" {
		refreshToken, _ = authMap["refresh_token"].(string)
	}
	if accessToken == "" || refreshToken == "" {
		return "", "", false
	}
	claims := decodeJWTPayloadMap(accessToken)
	if claims == nil {
		return "", "", false
	}
	iss, _ := claims["iss"].(string)
	allowedProviders, exists := codebuddyIssuers[iss]
	if !exists {
		return "", "", false
	}
	if expectedProvider != "" {
		matched := false
		for _, p := range allowedProviders {
			if p == expectedProvider {
				matched = true
				break
			}
		}
		if !matched {
			return "", "", false
		}
	}
	acctUID, _ := acctMap["uid"].(string)
	sub, _ := claims["sub"].(string)
	if acctUID == "" || acctUID != sub || !codebuddyUIDRe.MatchString(acctUID) {
		return "", "", false
	}
	if rClaims := decodeJWTPayloadMap(refreshToken); rClaims != nil {
		if rSub, _ := rClaims["sub"].(string); rSub != "" && rSub != acctUID {
			return "", "", false
		}
	}
	dom, _ := authMap["domain"].(string)
	return acctUID, dom, true
}

func decodeJWTPayloadMap(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) < 2 || parts[1] == "" {
		return nil
	}
	seg := parts[1]
	raw, err := base64.RawURLEncoding.DecodeString(seg)
	if err != nil {
		if padded := seg + strings.Repeat("=", (4-len(seg)%4)%4); padded != seg {
			raw, err = base64.URLEncoding.DecodeString(padded)
		}
		if err != nil {
			return nil
		}
	}
	var out map[string]any
	if json.Unmarshal(raw, &out) != nil {
		return nil
	}
	return out
}

// --- 原生日志归属 LRU 缓存 ---

type nativeWriteRecord struct {
	sessionID   string
	messageID   string
	timestampMS int64
	pid         string
}

type nativeLogFileCache struct {
	filePath   string
	provider   string
	accountRef string
	shared     bool
	dev        uint64
	ino        uint64
	size       int64
	mtimeNS    int64
	offset     int64
	writes     map[string]nativeWriteRecord
	pids       map[string]string
}

var (
	cbLogCacheMu    sync.Mutex
	cbLogCaches     = make(map[string]map[string]*nativeLogFileCache)
	cbLogCacheOrder []string
)

func takeNativeLogCache(aiHomeDir, hostHomeDir string) map[string]*nativeLogFileCache {
	key := aiHomeDir + "\x00" + hostHomeDir
	cbLogCacheMu.Lock()
	defer cbLogCacheMu.Unlock()
	if existing, ok := cbLogCaches[key]; ok {
		for i, k := range cbLogCacheOrder {
			if k == key {
				cbLogCacheOrder = append(append(cbLogCacheOrder[:i], cbLogCacheOrder[i+1:]...), key)
				break
			}
		}
		return existing
	}
	created := make(map[string]*nativeLogFileCache)
	cbLogCaches[key] = created
	cbLogCacheOrder = append(cbLogCacheOrder, key)
	for len(cbLogCacheOrder) > codebuddyLogCacheLimit {
		oldest := cbLogCacheOrder[0]
		cbLogCacheOrder = cbLogCacheOrder[1:]
		delete(cbLogCaches, oldest)
	}
	return created
}

type cbLogDescriptor struct {
	filePath   string
	provider   string
	accountRef string
	shared     bool
}

func discoverCodebuddyLogs(aiHomeDir, hostHomeDir string, accounts []CodebuddyAccountIdentity, now time.Time) []cbLogDescriptor {
	var logs []cbLogDescriptor
	if aiHomeDir != "" {
		base := filepath.Join(aiHomeDir, "run", "auth-projections")
		if physBase, err := filepath.EvalSymlinks(base); err == nil {
			privatePath := func(target string) bool {
				rel, rErr := filepath.Rel(base, target)
				if rErr != nil {
					return false
				}
				expected := filepath.Clean(filepath.Join(physBase, rel))
				actual, aErr := filepath.EvalSymlinks(target)
				if aErr != nil {
					return false
				}
				return actual == expected
			}
			for _, acct := range accounts {
				cfgDir := codebuddyConfigDirByProvider[acct.Provider]
				if cfgDir == "" {
					continue
				}
				seenHome := make(map[string]struct{})
				for _, home := range []string{
					resolveAccountRuntimeDir(aiHomeDir, acct.Provider, acct.AccountRef),
					resolveAccountCLIRuntimeDir(aiHomeDir, acct.Provider, acct.AccountRef),
				} {
					if home == "" {
						continue
					}
					if _, dup := seenHome[home]; dup {
						continue
					}
					seenHome[home] = struct{}{}
					logRoot := filepath.Join(home, cfgDir, "logs")
					if !privatePath(logRoot) {
						continue
					}
					days, err := os.ReadDir(logRoot)
					if err != nil {
						continue
					}
					for _, d := range days {
						if !d.IsDir() || !cbLogDayDirRe.MatchString(d.Name()) {
							continue
						}
						dayDir := filepath.Join(logRoot, d.Name())
						if !privatePath(dayDir) {
							continue
						}
						entries, rErr := os.ReadDir(dayDir)
						if rErr != nil {
							continue
						}
						for _, f := range entries {
							if f.IsDir() || !strings.HasSuffix(f.Name(), ".log") {
								continue
							}
							fp := filepath.Join(dayDir, f.Name())
							if privatePath(fp) {
								logs = append(logs, cbLogDescriptor{
									filePath:   fp,
									provider:   acct.Provider,
									accountRef: acct.AccountRef,
								})
							}
						}
					}
				}
			}
		}
	}

	if hostHomeDir != "" {
		sharedRoot := filepath.Join(hostHomeDir, codebuddySharedLogDirName, "logs")
		if now.IsZero() {
			now = time.Now()
		}
		cutoff := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location()).AddDate(0, 0, -(codebuddySharedLogDays - 1))
		if days, err := os.ReadDir(sharedRoot); err == nil {
			var validDays []string
			for _, d := range days {
				if !d.IsDir() || !cbLogDayDirRe.MatchString(d.Name()) {
					continue
				}
				parsed, pErr := time.ParseInLocation("2006-01-02", d.Name(), now.Location())
				if pErr != nil || parsed.Before(cutoff) {
					continue
				}
				validDays = append(validDays, d.Name())
			}
			sort.Strings(validDays)
			for _, dayName := range validDays {
				dayDir := filepath.Join(sharedRoot, dayName)
				entries, rErr := os.ReadDir(dayDir)
				if rErr != nil {
					continue
				}
				for _, f := range entries {
					if f.IsDir() || !strings.HasSuffix(f.Name(), ".log") {
						continue
					}
					logs = append(logs, cbLogDescriptor{
						filePath: filepath.Join(dayDir, f.Name()),
						shared:   true,
					})
				}
			}
		}
	}
	return logs
}

func readNativeLogFile(old *nativeLogFileCache, desc cbLogDescriptor) (*nativeLogFileCache, error) {
	info, err := os.Stat(desc.filePath)
	if err != nil {
		return nil, err
	}
	var dev, ino uint64
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		dev = uint64(st.Dev)
		ino = st.Ino
	}
	size := info.Size()
	mtimeNS := info.ModTime().UnixNano()
	sameFile := old != nil && old.provider == desc.provider && old.accountRef == desc.accountRef &&
		old.shared == desc.shared && old.dev == dev && old.ino == ino
	if sameFile && old.size == size && old.mtimeNS == mtimeNS {
		return old, nil
	}
	appendMode := sameFile && size > old.size
	writes := make(map[string]nativeWriteRecord)
	pids := make(map[string]string)
	startOffset := int64(0)
	if appendMode {
		for k, v := range old.writes {
			writes[k] = v
		}
		for k, v := range old.pids {
			pids[k] = v
		}
		startOffset = old.offset
	}
	type pendingWrite struct {
		rec    nativeWriteRecord
		offset int64
	}
	var pending []pendingWrite
	readRes := ReadJSONLFromOffset(desc.filePath, startOffset, func(line string, offset int64) {
		if m := cbUserIDLineRe.FindStringSubmatch(line); len(m) == 3 {
			pids[m[1]] = m[2]
		}
		for _, w := range parseNativeMessageWrites(line) {
			pending = append(pending, pendingWrite{rec: w, offset: offset})
		}
	})
	for _, p := range pending {
		if readRes.HadTrailingLine && p.offset >= readRes.TrailingLineStart {
			continue
		}
		key := fmt.Sprintf("%s:%s:%d", p.rec.sessionID, p.rec.messageID, p.rec.timestampMS)
		writes[key] = p.rec
	}
	return &nativeLogFileCache{
		filePath:   desc.filePath,
		provider:   desc.provider,
		accountRef: desc.accountRef,
		shared:     desc.shared,
		dev:        dev,
		ino:        ino,
		size:       size,
		mtimeNS:    mtimeNS,
		offset:     readRes.EffectiveOffset(),
		writes:     writes,
		pids:       pids,
	}, nil
}

func parseCodebuddyLogTimestamp(value string) int64 {
	if m := cbISOStampRe.FindStringSubmatch(value); len(m) == 8 {
		y, _ := strconv.Atoi(m[1])
		mo, _ := strconv.Atoi(m[2])
		d, _ := strconv.Atoi(m[3])
		h, _ := strconv.Atoi(m[4])
		mi, _ := strconv.Atoi(m[5])
		s, _ := strconv.Atoi(m[6])
		msStr := m[7] + strings.Repeat("0", 3-len(m[7]))
		ms, _ := strconv.Atoi(msStr)
		t := time.Date(y, time.Month(mo), d, h, mi, s, ms*1e6, time.Local)
		if t.Year() == y && int(t.Month()) == mo && t.Day() == d && t.Hour() == h && t.Minute() == mi && t.Second() == s {
			if unix := t.UnixMilli(); unix > 0 {
				return unix
			}
		}
		return 0
	}
	if m := cbUSStampRe.FindStringSubmatch(value); len(m) == 9 {
		mo, _ := strconv.Atoi(m[1])
		d, _ := strconv.Atoi(m[2])
		y, _ := strconv.Atoi(m[3])
		h, _ := strconv.Atoi(m[4])
		if h < 1 || h > 12 {
			return 0
		}
		h = h%12
		if m[7] == "PM" {
			h += 12
		}
		mi, _ := strconv.Atoi(m[5])
		s, _ := strconv.Atoi(m[6])
		msStr := m[8] + strings.Repeat("0", 3-len(m[8]))
		ms, _ := strconv.Atoi(msStr)
		t := time.Date(y, time.Month(mo), d, h, mi, s, ms*1e6, time.Local)
		if t.Year() == y && int(t.Month()) == mo && t.Day() == d && t.Hour() == h && t.Minute() == mi && t.Second() == s {
			if unix := t.UnixMilli(); unix > 0 {
				return unix
			}
		}
	}
	return 0
}

func parseNativeMessageWrites(line string) []nativeWriteRecord {
	m := cbWriteLineRe.FindStringSubmatch(line)
	if len(m) != 6 {
		return nil
	}
	atMS := parseCodebuddyLogTimestamp(m[1])
	if atMS <= 0 {
		return nil
	}
	pid := m[2]
	sessionID := m[3]
	rawTypes := strings.Split(m[4], ",")
	types := make([]string, len(rawTypes))
	for i, t := range rawTypes {
		types[i] = strings.TrimSpace(t)
	}
	entries := splitAddHistoryEntries(m[5])
	if len(entries) != len(types) {
		return nil
	}
	msgIDs := make([]string, 0, len(entries))
	for i, rawEntry := range entries {
		em := cbInputEntryRe.FindStringSubmatch(strings.TrimSpace(rawEntry))
		if len(em) != 3 || em[1] != types[i] {
			return nil
		}
		if em[1] == "message" {
			msgIDs = append(msgIDs, em[2])
		}
	}
	out := make([]nativeWriteRecord, 0, len(msgIDs))
	for _, msgID := range msgIDs {
		out = append(out, nativeWriteRecord{
			sessionID:   sessionID,
			messageID:   msgID,
			timestampMS: atMS,
			pid:         pid,
		})
	}
	return out
}

func splitAddHistoryEntries(input string) []string {
	var parts []string
	var start int
	depth := 0
	for i := 0; i < len(input); i++ {
		switch input[i] {
		case '{':
			if depth == 0 {
				start = i
			}
			depth++
		case '}':
			if depth > 0 {
				depth--
				if depth == 0 {
					parts = append(parts, input[start:i+1])
				}
			}
		}
	}
	return parts
}

type cbSessionEvidence struct {
	messages map[string][]cbOwnerCandidate
	owner    string
}

type cbOwnerCandidate struct {
	provider    string
	accountRef  string
	timestampMS int64
}

// CodebuddyOwnershipResolver 按写入日志、持久注册表、原生会话 DB user_id 判定 CodeBuddy 消息归属。
type CodebuddyOwnershipResolver struct {
	accounts       map[string]string
	identities     map[string][]CodebuddyAccountIdentity
	registryOwners map[string]map[string]struct{}
	usersByRoot    map[string]map[string]string
	sessions       map[string]*cbSessionEvidence
}

// NewCodebuddyOwnershipResolver 构建 CodeBuddy 会话与消息归属解析器。
func NewCodebuddyOwnershipResolver(
	ctx context.Context,
	aiHomeDir, hostHomeDir string,
	accountList []CodebuddyAccountIdentity,
	registryEntries []RegistryEntry,
	now time.Time,
) *CodebuddyOwnershipResolver {
	r := &CodebuddyOwnershipResolver{
		accounts:       make(map[string]string),
		identities:     make(map[string][]CodebuddyAccountIdentity),
		registryOwners: make(map[string]map[string]struct{}),
		usersByRoot:    make(map[string]map[string]string),
		sessions:       make(map[string]*cbSessionEvidence),
	}
	for _, acct := range accountList {
		prov := strings.ToLower(strings.TrimSpace(acct.Provider))
		ref := strings.TrimSpace(acct.AccountRef)
		if _, ok := codebuddyConfigDirByProvider[prov]; !ok || !IsAccountRef(ref) {
			continue
		}
		r.accounts[ref] = prov
		if acct.UID != "" {
			key := prov + ":" + acct.UID
			r.identities[key] = append(r.identities[key], CodebuddyAccountIdentity{
				Provider:   prov,
				AccountRef: ref,
				UID:        acct.UID,
			})
		}
	}

	if registryEntries == nil && aiHomeDir != "" {
		registryEntries = ListPersistentRegistryEntries(aiHomeDir)
	}
	for _, entry := range registryEntries {
		sid := strings.TrimSpace(entry.NativeSessionID)
		prov := strings.ToLower(strings.TrimSpace(entry.Provider))
		ref := strings.TrimSpace(entry.AccountRef)
		if _, ok := codebuddyConfigDirByProvider[prov]; !ok || sid == "" || !IsAccountRef(ref) {
			continue
		}
		set, exists := r.registryOwners[sid]
		if !exists {
			set = make(map[string]struct{})
			r.registryOwners[sid] = set
		}
		set[prov+":"+ref] = struct{}{}
	}

	r.buildLogEvidence(aiHomeDir, hostHomeDir, accountList, now)
	return r
}

func (r *CodebuddyOwnershipResolver) resolveUIDOwner(userID string) (CodebuddyAccountIdentity, bool) {
	uid := strings.TrimSpace(userID)
	if uid == "" {
		return CodebuddyAccountIdentity{}, false
	}
	unique := make(map[string]CodebuddyAccountIdentity)
	for key, list := range r.identities {
		idx := strings.IndexByte(key, ':')
		if idx < 0 || key[idx+1:] != uid {
			continue
		}
		for _, item := range list {
			unique[item.Provider+":"+item.AccountRef] = item
		}
	}
	if len(unique) != 1 {
		return CodebuddyAccountIdentity{}, false
	}
	for _, only := range unique {
		return only, true
	}
	return CodebuddyAccountIdentity{}, false
}

func (r *CodebuddyOwnershipResolver) buildLogEvidence(
	aiHomeDir, hostHomeDir string,
	accountList []CodebuddyAccountIdentity,
	now time.Time,
) {
	cache := takeNativeLogCache(aiHomeDir, hostHomeDir)
	cbLogCacheMu.Lock()
	defer cbLogCacheMu.Unlock()

	seen := make(map[string]struct{})
	for _, desc := range discoverCodebuddyLogs(aiHomeDir, hostHomeDir, accountList, now) {
		seen[desc.filePath] = struct{}{}
		updated, err := readNativeLogFile(cache[desc.filePath], desc)
		if err != nil {
			delete(cache, desc.filePath)
			continue
		}
		cache[desc.filePath] = updated
	}
	for fp := range cache {
		if _, ok := seen[fp]; !ok {
			delete(cache, fp)
		}
	}

	sessionOwners := make(map[string]map[string]struct{})
	for _, logEntry := range cache {
		for _, w := range logEntry.writes {
			var prov, ref string
			if !logEntry.shared {
				if logEntry.accountRef == "" {
					continue
				}
				prov = logEntry.provider
				ref = logEntry.accountRef
			} else {
				uid := logEntry.pids[w.pid]
				if uid == "" {
					continue
				}
				owner, ok := r.resolveUIDOwner(uid)
				if !ok || owner.AccountRef == "" {
					continue
				}
				prov = owner.Provider
				ref = owner.AccountRef
			}
			sess, ok := r.sessions[w.sessionID]
			if !ok {
				sess = &cbSessionEvidence{messages: make(map[string][]cbOwnerCandidate)}
				r.sessions[w.sessionID] = sess
			}
			sess.messages[w.messageID] = append(sess.messages[w.messageID], cbOwnerCandidate{
				provider:    prov,
				accountRef:  ref,
				timestampMS: w.timestampMS,
			})
			ownersSet, ok := sessionOwners[w.sessionID]
			if !ok {
				ownersSet = make(map[string]struct{})
				sessionOwners[w.sessionID] = ownersSet
			}
			ownersSet[prov+":"+ref] = struct{}{}
		}
	}
	for sid, ownersSet := range sessionOwners {
		if len(ownersSet) == 1 {
			for only := range ownersSet {
				r.sessions[sid].owner = only
			}
		}
	}
}

func (r *CodebuddyOwnershipResolver) readNativeUsers(projectsRoot string) map[string]string {
	if cached, ok := r.usersByRoot[projectsRoot]; ok {
		return cached
	}
	users := make(map[string]string)
	r.usersByRoot[projectsRoot] = users
	cfgRoot := filepath.Dir(projectsRoot)
	for _, dbName := range []string{"workbuddy.db", "codebuddy.db"} {
		dbPath := filepath.Join(cfgRoot, dbName)
		if info, err := os.Stat(dbPath); err != nil || !info.Mode().IsRegular() {
			continue
		}
		db, err := sql.Open("sqlite", "file:"+dbPath+"?mode=ro&_busy_timeout=5000")
		if err != nil {
			continue
		}
		rows, qErr := db.Query(`SELECT id, user_id FROM sessions`)
		if qErr == nil {
			for rows.Next() {
				var id, uid sql.NullString
				if rows.Scan(&id, &uid) == nil {
					if strings.TrimSpace(id.String) != "" && strings.TrimSpace(uid.String) != "" {
						users[strings.TrimSpace(id.String)] = strings.TrimSpace(uid.String)
					}
				}
			}
			_ = rows.Close()
		}
		_ = db.Close()
	}
	return users
}

func parseOwnerPair(pair string) (string, string, bool) {
	idx := strings.IndexByte(pair, ':')
	if idx <= 0 {
		return "", "", false
	}
	return pair[:idx], pair[idx+1:], true
}

// Resolve 判定一条 CodeBuddy 会话消息的 (provider, accountRef)；不唯一则返回空 accountRef。
func (r *CodebuddyOwnershipResolver) Resolve(file CodebuddyUsageFile, messageID string, timestampMS int64) (string, string) {
	if sess := r.sessions[file.SessionID]; sess != nil {
		candidates := sess.messages[messageID]
		matches := make(map[string]cbOwnerCandidate)
		for _, cand := range candidates {
			diff := cand.timestampMS - timestampMS
			if diff < 0 {
				diff = -diff
			}
			if diff <= codebuddyWriteTimeToleranceMS {
				matches[cand.provider+":"+cand.accountRef] = cand
			}
		}
		if len(matches) == 0 {
			if prov, ref, ok := parseOwnerPair(sess.owner); ok {
				return prov, ref
			}
			return file.Provider, ""
		}
		if len(matches) != 1 {
			return file.Provider, ""
		}
		for _, only := range matches {
			return only.provider, only.accountRef
		}
	}

	if sess := r.sessions[file.SessionID]; sess != nil && sess.owner != "" {
		if prov, ref, ok := parseOwnerPair(sess.owner); ok {
			return prov, ref
		}
	}
	if reg := r.registryOwners[file.SessionID]; len(reg) == 1 {
		for only := range reg {
			if prov, ref, ok := parseOwnerPair(only); ok {
				return prov, ref
			}
		}
	}
	uid := r.readNativeUsers(file.ProjectsRoot)[file.SessionID]
	if uid == "" {
		return file.Provider, ""
	}
	if owner, ok := r.resolveUIDOwner(uid); ok {
		return owner.Provider, owner.AccountRef
	}
	return file.Provider, ""
}

// ObservedCodebuddyLimit 是传递给上层运行时门禁的 CodeBuddy 429 冷却观察。
type ObservedCodebuddyLimit struct {
	Provider       string
	AccountRef     string
	Model          string
	StatusCode     int
	Detail         string
	Code           any
	ResetAtMS      int64
	HardExhaustion bool
	Source         string
	ObservedAtMS   int64
}

// CodebuddyLimitFunc 处理单次归属并带模型名的 429 冷却观察。
type CodebuddyLimitFunc func(ctx context.Context, obs ObservedCodebuddyLimit) bool

// CodebuddyLimitOptions 配置 CodeBuddy 429 会话冷却观察器。
type CodebuddyLimitOptions struct {
	AIHomeDir           string
	HostHomeDir         string
	Interval            time.Duration
	ListAccounts        func(ctx context.Context) []CodebuddyAccountIdentity
	IsPoolAccount       func(ctx context.Context, provider, accountRef string) bool
	ListRegistryEntries func() []RegistryEntry
	OnLimitObserved     CodebuddyLimitFunc
	Now                 func() time.Time
}

// CodebuddyLimitSummary 记录单轮 429 观察扫描摘要。
type CodebuddyLimitSummary struct {
	Files        int `json:"files"`
	Observed     int `json:"observed"`
	Applied      int `json:"applied"`
	Unattributed int `json:"unattributed"`
}

type cbFileCursor struct {
	offset int64
	model  string
}

type pendingCodebuddyLimit struct {
	file CodebuddyUsageFile
	model string
	obs  SessionLimitObservation
}

// CodebuddyLimitObserver 增量扫描 CodeBuddy 家族原生会话，将未过期 429 reset at / 硬耗尽反馈给运行时。
type CodebuddyLimitObserver struct {
	aiHomeDir           string
	hostHomeDir         string
	interval            time.Duration
	listAccounts        func(ctx context.Context) []CodebuddyAccountIdentity
	isPoolAccount       func(ctx context.Context, provider, accountRef string) bool
	listRegistryEntries func() []RegistryEntry
	onLimitObserved     CodebuddyLimitFunc
	nowFn               func() time.Time
	enabled             bool

	mu    sync.Mutex
	files map[string]*cbFileCursor

	runMu   sync.Mutex
	running bool
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

// NewCodebuddyLimitObserver 构造 CodeBuddy 429 冷却观察器。
func NewCodebuddyLimitObserver(options CodebuddyLimitOptions) *CodebuddyLimitObserver {
	aiHomeDir := strings.TrimSpace(options.AIHomeDir)
	hostHomeDir := strings.TrimSpace(options.HostHomeDir)
	interval := options.Interval
	if interval <= 0 {
		interval = DefaultCodebuddyLimitInterval
	}
	if interval < MinCodebuddyLimitInterval {
		interval = MinCodebuddyLimitInterval
	}
	listAccounts := options.ListAccounts
	if listAccounts == nil {
		listAccounts = func(ctx context.Context) []CodebuddyAccountIdentity {
			return LoadCodebuddyAccountIdentities(ctx, aiHomeDir)
		}
	}
	nowFn := options.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	enabled := aiHomeDir != "" && hostHomeDir != "" && options.OnLimitObserved != nil
	return &CodebuddyLimitObserver{
		aiHomeDir:           aiHomeDir,
		hostHomeDir:         hostHomeDir,
		interval:            interval,
		listAccounts:        listAccounts,
		isPoolAccount:       options.IsPoolAccount,
		listRegistryEntries: options.ListRegistryEntries,
		onLimitObserved:     options.OnLimitObserved,
		nowFn:               nowFn,
		enabled:             enabled,
		files:               make(map[string]*cbFileCursor),
	}
}

// Interval 返回扫描周期。
func (o *CodebuddyLimitObserver) Interval() time.Duration {
	return o.interval
}

// Tick 增量扫描全部 CodeBuddy 家族 jsonl 并触发冷却回调。
func (o *CodebuddyLimitObserver) Tick(ctx context.Context) CodebuddyLimitSummary {
	if ctx == nil {
		ctx = context.Background()
	}
	var summary CodebuddyLimitSummary
	if !o.enabled {
		return summary
	}

	discovered := DiscoverCodebuddyUsageFiles(o.hostHomeDir, codebuddyFamilyProviders, "")
	var pending []pendingCodebuddyLimit

	o.mu.Lock()
	for _, file := range discovered {
		info, err := os.Stat(file.FilePath)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		size := info.Size()
		cursor, exists := o.files[file.FilePath]
		if !exists {
			cursor = &cbFileCursor{}
			o.files[file.FilePath] = cursor
		}
		if size < cursor.offset {
			cursor.offset = 0
			cursor.model = ""
		}
		if size == cursor.offset {
			continue
		}
		summary.Files++
		nowMS := o.nowFn().UnixMilli()
		readRes := ReadJSONLFromOffset(file.FilePath, cursor.offset, func(line string, _ int64) {
			parsed := ReadSessionLimitLine(line)
			if parsed == nil {
				return
			}
			if parsed.Model != "" {
				cursor.model = parsed.Model
			}
			if parsed.Limit == nil {
				return
			}
			summary.Observed++
			if !parsed.Limit.HardExhaustion && parsed.Limit.ResetAtMS <= nowMS {
				return
			}
			pending = append(pending, pendingCodebuddyLimit{
				file:  file,
				model: cursor.model,
				obs:   *parsed.Limit,
			})
		})
		cursor.offset = readRes.EffectiveOffset()
	}
	o.mu.Unlock()

	if len(pending) == 0 {
		return summary
	}

	now := o.nowFn()
	accounts := o.listAccounts(ctx)
	var regEntries []RegistryEntry
	if o.listRegistryEntries != nil {
		regEntries = o.listRegistryEntries()
	}
	resolver := NewCodebuddyOwnershipResolver(ctx, o.aiHomeDir, o.hostHomeDir, accounts, regEntries, now)
	poolSet := make(map[string]struct{}, len(accounts))
	for _, acct := range accounts {
		poolSet[strings.ToLower(strings.TrimSpace(acct.Provider))+":"+strings.TrimSpace(acct.AccountRef)] = struct{}{}
	}

	for _, item := range pending {
		prov, ref := resolver.Resolve(item.file, item.obs.ID, item.obs.AtMS)
		prov = strings.ToLower(strings.TrimSpace(prov))
		if prov == "" {
			prov = item.file.Provider
		}
		ref = strings.TrimSpace(ref)
		inPool := false
		if ref != "" {
			if o.isPoolAccount != nil {
				inPool = o.isPoolAccount(ctx, prov, ref)
			} else {
				_, inPool = poolSet[prov+":"+ref]
			}
		}
		if !inPool {
			summary.Unattributed++
			continue
		}
		model := item.model
		if model == "" {
			model = FindRequestModelInCliLogs(o.aiHomeDir, o.hostHomeDir, prov, ref, item.obs.RequestID, item.obs.AtMS, now)
		}
		if model == "" {
			summary.Unattributed++
			continue
		}
		applied := o.onLimitObserved(ctx, ObservedCodebuddyLimit{
			Provider:       prov,
			AccountRef:     ref,
			Model:          model,
			StatusCode:     429,
			Detail:         item.obs.Message,
			Code:           item.obs.Code,
			ResetAtMS:      item.obs.ResetAtMS,
			HardExhaustion: item.obs.HardExhaustion,
			Source:         "codebuddy.session.limit",
			ObservedAtMS:   o.nowFn().UnixMilli(),
		})
		if applied {
			summary.Applied++
		}
	}
	return summary
}

// Start 启动周期扫描。
func (o *CodebuddyLimitObserver) Start(parent context.Context) bool {
	o.runMu.Lock()
	defer o.runMu.Unlock()
	if o.running || !o.enabled {
		return false
	}
	if parent == nil {
		parent = context.Background()
	}
	runCtx, cancel := context.WithCancel(parent)
	o.cancel = cancel
	o.running = true
	o.Tick(runCtx)
	o.wg.Add(1)
	go func() {
		defer o.wg.Done()
		ticker := time.NewTicker(o.interval)
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				o.Tick(runCtx)
			}
		}
	}()
	return true
}

// Stop 停止周期扫描并等待协程结束。
func (o *CodebuddyLimitObserver) Stop() bool {
	o.runMu.Lock()
	if !o.running {
		o.runMu.Unlock()
		return false
	}
	cancel := o.cancel
	o.cancel = nil
	o.running = false
	o.runMu.Unlock()
	if cancel != nil {
		cancel()
	}
	o.wg.Wait()
	return true
}

// unused guard helper kept local for stable log cache diagnostics if needed
func stableHashHex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:8])
}

var _ = stableHashHex
