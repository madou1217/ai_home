package managementops

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

const codebuddyProjectionVersion = 2

var (
	codebuddySessionIDRe     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
	codebuddyHex32Re         = regexp.MustCompile(`^[a-f0-9]{32}$`)
	codebuddyUIDRe           = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	cbOutcomeTimeoutRe       = regexp.MustCompile(`(?i)timed out|timeout`)
	cbOutcomeNetworkRe       = regexp.MustCompile(`(?i)network|socket|econn|reset|dns|connect`)
	cbOutcomeRateLimitRe     = regexp.MustCompile(`(?i)429|too many requests|frequency limit|rate limit`)
	cbOutcomeQuotaRe         = regexp.MustCompile(`(?i)quota|exhaust|usage limit|insufficient.*(quota|balance)|billing`)
	cbOutcomeCredentialRe    = regexp.MustCompile(`(?i)401|403|unauthor|invalid.*(token|credential)|authentication`)
	cbOutcomePermissionRe    = regexp.MustCompile(`(?i)permission|forbidden`)
	cbOutcomeUpstreamRe      = regexp.MustCompile(`(?i)5\d\d|server error|service unavailable|overloaded|bad gateway`)
	cbOutcomeMalformedRe     = regexp.MustCompile(`(?i)empty stream|no valid response|finish_reason=error|malformed|parse`)
	cbOutcomeInvalidReqRe    = regexp.MustCompile(`(?i)context.*(length|window)|too many tokens`)
	cbLogPIDRe               = regexp.MustCompile(`pid[=:\s]+(\d+)`)
	cbLogUserIDRe            = regexp.MustCompile(`"userId"\s*:\s*"([A-Za-z0-9_-]+)"|userId[=:\s]+([A-Za-z0-9_-]+)`)
	cbLogAddHistRe           = regexp.MustCompile(`\[addHistory\].*?(?:messageId|msgId)[=:\s"]+([A-Za-z0-9_-]+)`)
)

var codebuddyConfigDirByProvider = map[string]string{
	"codebuddy":   ".codebuddy",
	"codebuddycn": ".codebuddy-cn",
	"workbuddy":   ".workbuddy-ai",
	"workbuddycn": ".workbuddy",
}

var codebuddyProviderByConfigDir = map[string]string{
	".codebuddy":    "codebuddy",
	".codebuddy-cn": "codebuddycn",
	".workbuddy-ai": "workbuddy",
	".workbuddy":    "workbuddycn",
}

var codebuddySessionRootsByProvider = map[string][]string{
	"codebuddy":   {".codebuddy", ".workbuddy-ai"},
	"workbuddy":   {".workbuddy-ai", ".codebuddy"},
	"codebuddycn": {".codebuddy-cn", ".workbuddy"},
	"workbuddycn": {".workbuddy", ".codebuddy-cn"},
}

var codebuddyIssuers = map[string][]string{
	"https://www.codebuddy.ai/auth/realms/copilot":   {"codebuddy"},
	"https://www.workbuddy.ai/auth/realms/copilot":   {"workbuddy"},
	"https://www.workbuddy.cn/auth/realms/copilot":   {"codebuddycn", "workbuddycn"},
	"https://www.codebuddy.cn/auth/realms/copilot":   {"codebuddycn", "workbuddycn"},
	"https://copilot.tencent.com/auth/realms/copilot": {"codebuddycn", "workbuddycn"},
}

type codebuddyUsageFile struct {
	FilePath       string
	Provider       string
	ProjectsRoot   string
	SessionID      string
	ProjectDirName string
	Ino            uint64
}

type codebuddyIdentityInfo struct {
	Provider   string
	AccountRef string
	UID        string
	Domain     string
}

type codebuddyLogCorrelation struct {
	PID     string
	MsgID   string
	AtMS    int64
	UserID  string
}

type codebuddyOwnership struct {
	HostHomeDir    string
	AIHomeDir      string
	Accounts       []codebuddyIdentityInfo
	ByUIDAndProv   map[string][]codebuddyIdentityInfo // key: provider+"\x00"+uid
	BySessPersistent map[string]string                // nativeSessionId -> accountRef
	AddHistoryByMsg map[string][]codebuddyLogCorrelation
	PIDUserIDs     map[string]string
	Fingerprint    string
	WriterFPByRoot map[string]string
}

func scanCodebuddyFamilySources(
	ctx context.Context,
	opts ScanUsageOptions,
	familyProviders []string,
	nowFn func() time.Time,
) map[string]providerScanCounters {
	out := make(map[string]providerScanCounters, len(familyProviders))
	for _, p := range familyProviders {
		out[p] = providerScanCounters{}
	}

	identities := loadCodebuddyIdentities(ctx, opts.AccountStore)
	ownership := buildCodebuddyOwnership(ctx, opts.HostHomeDir, opts.AIHomeDir, identities, nowFn)
	files := discoverCodebuddyUsageFiles(opts.HostHomeDir, familyProviders, opts.CodebuddySessionID)

	for _, file := range files {
		cnt := out[file.Provider]
		scanned, err := scanCodebuddyUsageFile(ctx, opts.Store, file, ownership, opts.CodebuddyScope)
		if err != nil {
			cnt.Skipped++
			out[file.Provider] = cnt
			continue
		}
		cnt.Files++
		cnt.Records += scanned.Records
		cnt.Prompts += scanned.Prompts
		out[file.Provider] = cnt
	}

	ideCounts := scanCodebuddyIdeUsage(ctx, opts, familyProviders, identities)
	for prov, ic := range ideCounts {
		cnt := out[prov]
		cnt.Files += ic.Files
		cnt.Records += ic.Records
		cnt.Prompts += ic.Prompts
		cnt.Skipped += ic.Skipped
		out[prov] = cnt
	}

	return out
}

func loadCodebuddyIdentities(ctx context.Context, acctStore *sqliteaccount.Store) []codebuddyIdentityInfo {
	if acctStore == nil {
		return nil
	}
	var out []codebuddyIdentityInfo
	cursor := accountcore.AccountRef("")
	for {
		q, err := accountapp.NewOverviewQuery(cursor, accountapp.MaxOverviewLimit)
		if err != nil {
			break
		}
		page, err := acctStore.ListAccountOverviews(ctx, q)
		if err != nil {
			break
		}
		for _, ov := range page {
			acct := ov.Account()
			prov := strings.ToLower(strings.TrimSpace(acct.ProviderID()))
			if !isCodebuddyFamilyProvider(prov) {
				continue
			}
			cred, err := acctStore.GetCredential(ctx, acct.Ref())
			if err != nil || cred == nil {
				continue
			}
			native, ok := cred.(*accountcore.NativeCredential)
			if !ok {
				continue
			}
			uid, domain, valid := inspectCodebuddyCredentialPayload(native.Payload(), prov)
			if !valid {
				continue
			}
			out = append(out, codebuddyIdentityInfo{
				Provider:   prov,
				AccountRef: acct.Ref().String(),
				UID:        uid,
				Domain:     domain,
			})
		}
		if len(page) < accountapp.MaxOverviewLimit {
			break
		}
		last := page[len(page)-1].Account().Ref()
		if last == cursor {
			break
		}
		cursor = last
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Provider != out[j].Provider {
			return out[i].Provider < out[j].Provider
		}
		return out[i].AccountRef < out[j].AccountRef
	})
	return out
}

func isCodebuddyFamilyProvider(provider string) bool {
	p := strings.ToLower(strings.TrimSpace(provider))
	_, ok := codebuddyConfigDirByProvider[p]
	return ok
}

func inspectCodebuddyCredentialPayload(raw []byte, expectedProvider string) (uid, domain string, ok bool) {
	if len(raw) == 0 || len(raw) > 1024*1024 {
		return "", "", false
	}
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return "", "", false
	}
	if creds := mapVal(doc, "credentials"); creds != nil {
		doc = creds
	}
	authMap := mapVal(doc, "auth")
	acctMap := mapVal(doc, "account")
	if authMap == nil || acctMap == nil {
		return "", "", false
	}
	accessToken := strVal(authMap, "accessToken")
	refreshToken := strVal(authMap, "refreshToken")
	if accessToken == "" || refreshToken == "" {
		return "", "", false
	}
	accessClaims := decodeJWTClaimsMap(accessToken)
	if accessClaims == nil {
		return "", "", false
	}
	iss := strVal(accessClaims, "iss")
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
	acctUID := strVal(acctMap, "uid")
	sub := strVal(accessClaims, "sub")
	if acctUID == "" || acctUID != sub || !codebuddyUIDRe.MatchString(acctUID) {
		return "", "", false
	}
	if refreshClaims := decodeJWTClaimsMap(refreshToken); refreshClaims != nil {
		if rSub := strVal(refreshClaims, "sub"); rSub != "" && rSub != acctUID {
			return "", "", false
		}
	}
	return acctUID, strVal(authMap, "domain"), true
}

func decodeJWTClaimsMap(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil
	}
	seg := parts[1]
	if seg == "" {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(seg)
	if err != nil {
		// 容忍带 padding 的标准/URL base64
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

func discoverCodebuddyUsageFiles(hostHomeDir string, providers []string, sessionIDFilter string) []codebuddyUsageFile {
	sidFilter := strings.TrimSpace(sessionIDFilter)
	if sidFilter != "" && !codebuddySessionIDRe.MatchString(sidFilter) {
		return nil
	}
	type rootEntry struct {
		Root     string
		Provider string
	}
	roots := make(map[string]rootEntry)
	nativeHome := resolvePhysicalPath(hostHomeDir)

	for _, prov := range providers {
		for _, dir := range codebuddySessionRootsByProvider[prov] {
			root := filepath.Join(hostHomeDir, dir, "projects")
			phys := resolvePhysicalPath(root)
			ownerProv := codebuddyProviderByConfigDir[dir]
			if existing, ok := roots[phys]; !ok || phys == filepath.Join(nativeHome, dir, "projects") {
				if ownerProv == "" {
					ownerProv = prov
				}
				_ = existing
				roots[phys] = rootEntry{Root: root, Provider: ownerProv}
			}
		}
	}

	rootKeys := make([]string, 0, len(roots))
	for k := range roots {
		rootKeys = append(rootKeys, k)
	}
	sort.Strings(rootKeys)

	identities := make(map[string]struct{})
	var files []codebuddyUsageFile
	seenFiles := make(map[string]struct{})

	for _, physRoot := range rootKeys {
		re := roots[physRoot]
		projDirs, err := os.ReadDir(re.Root)
		if err != nil {
			continue
		}
		for _, pd := range projDirs {
			if !pd.IsDir() {
				continue
			}
			pDir := filepath.Join(re.Root, pd.Name())
			var candidateNames []string
			if sidFilter != "" {
				candidateNames = []string{sidFilter + ".jsonl"}
			} else {
				entries, err := os.ReadDir(pDir)
				if err != nil {
					continue
				}
				for _, e := range entries {
					candidateNames = append(candidateNames, e.Name())
				}
			}
			for _, name := range candidateNames {
				if !strings.HasSuffix(name, ".jsonl") {
					continue
				}
				sid := strings.TrimSuffix(name, ".jsonl")
				if !codebuddySessionIDRe.MatchString(sid) {
					continue
				}
				fp := filepath.Join(pDir, name)
				st, err := os.Stat(fp)
				if err != nil || !st.Mode().IsRegular() {
					continue
				}
				physFile := resolvePhysicalPath(fp)
				var inoVal uint64
				identity := physFile
				if sys, ok := st.Sys().(*syscall.Stat_t); ok && sys != nil && sys.Ino > 0 {
					inoVal = sys.Ino
					identity = fmt.Sprintf("%d:%d", sys.Dev, sys.Ino)
				}
				if _, dup := identities[identity]; dup {
					continue
				}
				if _, dup := seenFiles[physFile]; dup {
					continue
				}
				identities[identity] = struct{}{}
				seenFiles[physFile] = struct{}{}
				files = append(files, codebuddyUsageFile{
					FilePath:       physFile,
					Provider:       re.Provider,
					ProjectsRoot:   re.Root,
					SessionID:      sid,
					ProjectDirName: pd.Name(),
					Ino:            inoVal,
				})
			}
		}
	}

	sort.Slice(files, func(i, j int) bool { return files[i].FilePath < files[j].FilePath })
	return files
}

func buildCodebuddyOwnership(
	ctx context.Context,
	hostHomeDir, aiHomeDir string,
	identities []codebuddyIdentityInfo,
	nowFn func() time.Time,
) *codebuddyOwnership {
	own := &codebuddyOwnership{
		HostHomeDir:      hostHomeDir,
		AIHomeDir:        aiHomeDir,
		Accounts:         identities,
		ByUIDAndProv:     make(map[string][]codebuddyIdentityInfo),
		BySessPersistent: make(map[string]string),
		AddHistoryByMsg:  make(map[string][]codebuddyLogCorrelation),
		PIDUserIDs:       make(map[string]string),
		WriterFPByRoot:   make(map[string]string),
	}

	var fpParts []string
	for _, id := range identities {
		key := id.Provider + "\x00" + id.UID
		own.ByUIDAndProv[key] = append(own.ByUIDAndProv[key], id)
		fpParts = append(fpParts, id.Provider+":"+id.AccountRef+":"+id.UID)
	}
	own.Fingerprint = StableHash(strings.Join(fpParts, "|"))

	for _, item := range readPersistentSessionEntries(aiHomeDir) {
		prov := strings.ToLower(strings.TrimSpace(item.Provider))
		if !isCodebuddyFamilyProvider(prov) || item.Gateway {
			continue
		}
		ref := strings.TrimSpace(item.AccountRef)
		nsid := strings.TrimSpace(item.NativeSessionID)
		if isAccountRefFormat(ref) && nsid != "" {
			own.BySessPersistent[prov+"\x00"+nsid] = ref
		}
	}

	// 读取最近 2 天共享日志以辅助 userId <-> pid <-> messageId 关联
	now := nowFn()
	dayDirs := []string{
		now.Format("2006-01-02"),
		now.Add(-24 * time.Hour).Format("2006-01-02"),
	}
	seenLogFiles := make(map[string]struct{})
	for _, cfgDir := range []string{".codebuddy", ".codebuddy-cn", ".workbuddy-ai", ".workbuddy"} {
		for _, day := range dayDirs {
			logDir := filepath.Join(hostHomeDir, cfgDir, "logs", day)
			entries, err := os.ReadDir(logDir)
			if err != nil {
				continue
			}
			for _, e := range entries {
				if e.IsDir() {
					continue
				}
				lp := filepath.Join(logDir, e.Name())
				phys := resolvePhysicalPath(lp)
				if _, dup := seenLogFiles[phys]; dup {
					continue
				}
				seenLogFiles[phys] = struct{}{}
				parseCodebuddySharedLog(ctx, phys, own)
			}
		}
	}

	return own
}

func parseCodebuddySharedLog(ctx context.Context, logPath string, own *codebuddyOwnership) {
	_ = ctx
	st, err := os.Stat(logPath)
	if err != nil || !st.Mode().IsRegular() || st.Size() > 16*1024*1024 {
		return
	}
	raw, err := os.ReadFile(logPath)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if line == "" {
			continue
		}
		var pid string
		if m := cbLogPIDRe.FindStringSubmatch(line); len(m) == 2 {
			pid = m[1]
		}
		if pid != "" {
			if m := cbLogUserIDRe.FindStringSubmatch(line); len(m) == 3 {
				uid := m[1]
				if uid == "" {
					uid = m[2]
				}
				if uid != "" {
					own.PIDUserIDs[pid] = uid
				}
			}
		}
		if strings.Contains(line, "[addHistory]") {
			if m := cbLogAddHistRe.FindStringSubmatch(line); len(m) == 2 {
				msgID := m[1]
				var atMS int64
				if len(line) >= 24 {
					atMS = toTimestampMS(line[:24])
				}
				own.AddHistoryByMsg[msgID] = append(own.AddHistoryByMsg[msgID], codebuddyLogCorrelation{
					PID:    pid,
					MsgID:  msgID,
					AtMS:   atMS,
					UserID: own.PIDUserIDs[pid],
				})
			}
		}
	}
}

func (o *codebuddyOwnership) resolveNativeUID(file codebuddyUsageFile) (uid string, directAccountRef string) {
	if o.AIHomeDir != "" {
		projBase := filepath.Join(o.AIHomeDir, "run", "auth-projections", file.Provider)
		if isPathWithinRoot(file.ProjectsRoot, projBase) {
			if rel, err := filepath.Rel(projBase, file.ProjectsRoot); err == nil {
				parts := strings.Split(rel, string(filepath.Separator))
				if len(parts) >= 1 && isAccountRefFormat(parts[0]) {
					ref := parts[0]
					for _, id := range o.Accounts {
						if id.Provider == file.Provider && id.AccountRef == ref {
							return id.UID, ref
						}
					}
					return "", ref
				}
			}
		}
	}
	// 检查相邻 workbuddy.db / codebuddy db 里的 sessions 表
	configRoot := filepath.Dir(file.ProjectsRoot)
	for _, dbName := range []string{"workbuddy.db", "codebuddy.db"} {
		dbPath := filepath.Join(configRoot, dbName)
		if !pathExists(dbPath) {
			continue
		}
		if db, err := sql.Open("sqlite", buildReadOnlySQLiteDSN(dbPath)); err == nil {
			var u string
			_ = db.QueryRow(`SELECT user_id FROM sessions WHERE id = ? LIMIT 1`, file.SessionID).Scan(&u)
			_ = db.Close()
			if strings.TrimSpace(u) != "" {
				return strings.TrimSpace(u), ""
			}
		}
	}
	return "", ""
}

func (o *codebuddyOwnership) writerFingerprint(file codebuddyUsageFile) string {
	if fp, ok := o.WriterFPByRoot[file.ProjectsRoot]; ok {
		return fp
	}
	cfgDir := filepath.Dir(file.ProjectsRoot)
	var parts []string
	for _, dbName := range []string{"workbuddy.db", "codebuddy.db"} {
		if st, err := os.Stat(filepath.Join(cfgDir, dbName)); err == nil {
			parts = append(parts, fmt.Sprintf("%s:%d:%d", dbName, st.Size(), st.ModTime().UnixMilli()))
		}
	}
	fp := StableHash(strings.Join(parts, "|"))
	o.WriterFPByRoot[file.ProjectsRoot] = fp
	return fp
}

func (o *codebuddyOwnership) resolveMessageOwner(
	file codebuddyUsageFile,
	atMS int64,
	scopeRef string,
	prevOwner *UsageOwnerRecord,
	messageID string,
) (provider, accountRef string) {
	if prevOwner != nil && prevOwner.AccountRef != "" {
		return prevOwner.Provider, prevOwner.AccountRef
	}
	if scopeRef != "" {
		return file.Provider, scopeRef
	}
	if ref := o.BySessPersistent[file.Provider+"\x00"+file.SessionID]; ref != "" {
		return file.Provider, ref
	}

	nativeUID, directRef := o.resolveNativeUID(file)
	if directRef != "" {
		return file.Provider, directRef
	}

	uid := nativeUID
	if uid == "" && messageID != "" {
		matchedUIDs := make(map[string]struct{})
		for _, corr := range o.AddHistoryByMsg[messageID] {
			if corr.AtMS > 0 && atMS > 0 && absInt64(corr.AtMS-atMS) > 5000 {
				continue
			}
			candUID := corr.UserID
			if candUID == "" && corr.PID != "" {
				candUID = o.PIDUserIDs[corr.PID]
			}
			if candUID != "" {
				matchedUIDs[candUID] = struct{}{}
			}
		}
		if len(matchedUIDs) == 1 {
			for u := range matchedUIDs {
				uid = u
			}
		}
	}

	if uid != "" {
		cands := o.ByUIDAndProv[file.Provider+"\x00"+uid]
		if len(cands) == 1 {
			return cands[0].Provider, cands[0].AccountRef
		}
		// 同站跨客户端回退（例如 codebuddycn / workbuddycn 同 realm 共用 UID）
		cn := strings.HasSuffix(file.Provider, "cn")
		var sameSite []codebuddyIdentityInfo
		for _, id := range o.Accounts {
			if id.UID == uid && strings.HasSuffix(id.Provider, "cn") == cn {
				sameSite = append(sameSite, id)
			}
		}
		if len(sameSite) == 1 {
			return sameSite[0].Provider, sameSite[0].AccountRef
		}
	}
	return file.Provider, ""
}

func absInt64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

func readCodebuddyEntryUsage(entry map[string]any) (in, out, cacheRead, cacheCreation, reasoning, total int64, ok bool) {
	if strVal(entry, "type") != "message" || strVal(entry, "role") != "assistant" {
		return
	}
	data := mapVal(entry, "providerData")
	rawUsage := mapVal(data, "rawUsage")
	normalized := mapVal(data, "usage")
	message := mapVal(entry, "message")
	fallback := mapVal(message, "usage")

	var rawIn, rawOut int64
	if rawUsage != nil {
		rawIn = int64FromMap(rawUsage, "prompt_tokens")
		rawOut = int64FromMap(rawUsage, "completion_tokens")
	} else {
		rawIn = int64FromMap(normalized, "inputTokens")
		if rawIn == 0 {
			rawIn = int64FromMap(fallback, "input_tokens")
		}
		rawOut = int64FromMap(normalized, "outputTokens")
		if rawOut == 0 {
			rawOut = int64FromMap(fallback, "output_tokens")
		}
	}
	if rawIn == 0 && rawOut == 0 {
		return
	}

	if rawUsage != nil {
		cacheRead = minInt64Val(rawIn, int64FromMap(rawUsage, "prompt_cache_hit_tokens", "cache_read_input_tokens"))
		if cacheRead == 0 {
			if ptd := mapVal(rawUsage, "prompt_tokens_details"); ptd != nil {
				cacheRead = minInt64Val(rawIn, int64FromMap(ptd, "cached_tokens"))
			}
		}
		cacheCreation = minInt64Val(rawIn-cacheRead, int64FromMap(rawUsage, "cache_creation_input_tokens"))
		if cacheCreation == 0 {
			cacheCreation = minInt64Val(rawIn-cacheRead, int64FromMap(fallback, "cache_creation_input_tokens"))
		}
		if ctd := mapVal(rawUsage, "completion_tokens_details"); ctd != nil {
			reasoning = minInt64Val(rawOut, int64FromMap(ctd, "reasoning_tokens"))
		}
		if reasoning == 0 {
			reasoning = minInt64Val(rawOut, int64FromMap(rawUsage, "completion_thinking_tokens"))
		}
	} else {
		if arr, ok := normalized["inputTokensDetails"].([]any); ok && len(arr) > 0 {
			if m, ok := arr[0].(map[string]any); ok {
				cacheRead = minInt64Val(rawIn, int64FromMap(m, "cached_tokens"))
			}
		}
		if cacheRead == 0 {
			cacheRead = minInt64Val(rawIn, int64FromMap(fallback, "cache_read_input_tokens"))
		}
		cacheCreation = minInt64Val(rawIn-cacheRead, int64FromMap(fallback, "cache_creation_input_tokens"))
		if arr, ok := normalized["outputTokensDetails"].([]any); ok && len(arr) > 0 {
			if m, ok := arr[0].(map[string]any); ok {
				reasoning = minInt64Val(rawOut, int64FromMap(m, "reasoning_tokens"))
			}
		}
	}

	in = maxInt64Zero(rawIn - cacheRead - cacheCreation)
	out = maxInt64Zero(rawOut - reasoning)
	total = rawIn + rawOut
	return in, out, cacheRead, cacheCreation, reasoning, total, true
}

func classifyCodebuddyOutcome(errMap map[string]any) string {
	if errMap == nil {
		return "success"
	}
	if b, _ := boolVal(errMap, "isStreamTimeout"); b {
		return "stream_disconnected"
	}
	msg := strings.ToLower(strVal(errMap, "message"))
	if cbOutcomeTimeoutRe.MatchString(msg) {
		return "stream_disconnected"
	}
	if b, _ := boolVal(errMap, "isNetworkError"); b || cbOutcomeNetworkRe.MatchString(msg) {
		return "connection_reset"
	}
	if cbOutcomeRateLimitRe.MatchString(msg) {
		return "rate_limited"
	}
	if cbOutcomeQuotaRe.MatchString(msg) {
		return "quota_exhausted"
	}
	if cbOutcomeCredentialRe.MatchString(msg) {
		return "credential_rejected"
	}
	if cbOutcomePermissionRe.MatchString(msg) {
		return "permission_denied"
	}
	if cbOutcomeUpstreamRe.MatchString(msg) {
		return "upstream_unavailable"
	}
	if cbOutcomeMalformedRe.MatchString(msg) {
		return "malformed_response"
	}
	if cbOutcomeInvalidReqRe.MatchString(msg) {
		return "invalid_request"
	}
	return "unclassified"
}

func scanCodebuddyUsageFile(
	ctx context.Context,
	store *UsageStore,
	file codebuddyUsageFile,
	ownership *codebuddyOwnership,
	explicitScope string,
) (fileScanOutcome, error) {
	stat, err := os.Stat(file.FilePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	mtimeMS := float64(stat.ModTime().UnixNano()) / 1e6
	curState, err := store.GetFileState(ctx, file.FilePath)
	if err != nil {
		return fileScanOutcome{}, err
	}
	curCtx := curState.ScanContext
	nativeUID, directRef := ownership.resolveNativeUID(file)
	identity := fmt.Sprintf("%s:%s:%s:%s", ownership.Fingerprint, nativeUID, directRef, ownership.writerFingerprint(file))

	activeScope := strings.TrimSpace(explicitScope)
	if activeScope == "" {
		activeScope = contextString(curCtx, "latestScope")
	}
	scopeRef := ""
	if isAccountRefFormat(activeScope) {
		scopeRef = activeScope
	} else if activeScope != "" {
		if parsed := safeParseJSONMap(activeScope); parsed != nil {
			if strings.EqualFold(strVal(parsed, "provider"), file.Provider) {
				if ref := strVal(parsed, "accountRef"); isAccountRefFormat(ref) {
					scopeRef = ref
				}
			}
		}
	}

	rebuild := contextInt64(curCtx, "codebuddyUsageProjectionVersion") != codebuddyProjectionVersion ||
		contextString(curCtx, "identity") != identity ||
		stat.Size() < curState.Offset ||
		explicitScope != "" ||
		contextInt64(curCtx, "ino") != int64(file.Ino)

	if !rebuild && stat.Size() == curState.Size && mtimeMS == contextFloat64(curCtx, "mtimeMs") {
		return fileScanOutcome{}, nil
	}

	startOffset := curState.Offset
	if rebuild || stat.Size() == curState.Size {
		startOffset = 0
	}

	region := "global"
	if strings.HasSuffix(file.Provider, "cn") {
		region = "cn"
	}
	prefix := "codebuddy:message:" + StableHash(region+":"+file.SessionID) + ":"
	outcomePrefix := "codebuddy:outcome:" + StableHash(file.SessionID) + ":"
	prevOwners, _ := store.ReadUsageOwnersByEventGlob(ctx, prefix+"*:usage")

	cwd := contextString(curCtx, "cwd")
	startedAtMS := contextInt64(curCtx, "startedAtMs")
	updatedAtMS := contextInt64(curCtx, "updatedAtMs")
	var records []UsageRecordInput
	var prompts []UsagePromptEventInput
	var outcomes []NativeOutcomeInput

	readRes, err := readJSONLFromOffset(file.FilePath, startOffset, -1, func(line string, _ int64) {
		entry := safeParseJSONMap(line)
		if entry == nil {
			return
		}
		at := toTimestampMS(entry["timestamp"])
		id := strVal(entry, "id")
		if at <= 0 || id == "" {
			return
		}
		if esid := strVal(entry, "sessionId"); esid != "" && esid != file.SessionID {
			return
		}
		if c := strVal(entry, "cwd"); c != "" {
			cwd = c
		}
		if startedAtMS == 0 || at < startedAtMS {
			startedAtMS = at
		}
		if at > updatedAtMS {
			updatedAtMS = at
		}

		evKeyUsage := prefix + StableHash(id) + ":usage"
		var prevRec *UsageOwnerRecord
		if p, ok := prevOwners[evKeyUsage]; ok {
			prevRec = &p
		}
		ownerProv, ownerRef := ownership.resolveMessageOwner(file, at, scopeRef, prevRec, id)

		entryType := strVal(entry, "type")
		role := strVal(entry, "role")
		if entryType == "message" && role == "user" {
			prompts = append(prompts, UsagePromptEventInput{
				EventKey:    prefix + StableHash(id) + ":prompt",
				Provider:    ownerProv,
				SessionID:   file.SessionID,
				TimestampMS: at,
			})
		}

		inTok, outTok, crTok, cwTok, reasTok, totTok, hasUsage := readCodebuddyEntryUsage(entry)
		pdata := mapVal(entry, "providerData")
		msg := mapVal(entry, "message")
		model := strVal(pdata, "model")
		if model == "" {
			model = strVal(msg, "model")
		}

		if entryType == "message" && role == "assistant" && ownerRef != "" {
			errMap := mapVal(pdata, "error")
			outcome := ""
			if errMap != nil {
				outcome = classifyCodebuddyOutcome(errMap)
			} else if hasUsage && model != "" {
				outcome = "success"
			}
			if outcome != "" {
				outcomes = append(outcomes, NativeOutcomeInput{
					EventKey:    outcomePrefix + StableHash(id),
					AccountRef:  ownerRef,
					Provider:    ownerProv,
					SessionID:   file.SessionID,
					Outcome:     outcome,
					TimestampMS: at,
				})
			}
		}

		if !hasUsage || model == "" {
			return
		}
		records = append(records, UsageRecordInput{
			EventKey:                 evKeyUsage,
			Provider:                 ownerProv,
			AccountRef:               ownerRef,
			SourceKind:               "session_jsonl",
			SessionID:                file.SessionID,
			RequestID:                strVal(pdata, "conversationRequestId"),
			Model:                    model,
			InputTokens:              inTok,
			OutputTokens:             outTok,
			CacheReadInputTokens:     crTok,
			CacheCreationInputTokens: cwTok,
			ReasoningOutputTokens:    reasTok,
			TotalTokens:              totTok,
			TimestampMS:              at,
			CWD:                      cwd,
			Project:                  inferProjectFromCwd(cwd, file.ProjectDirName),
		})
	})
	if err != nil {
		return fileScanOutcome{}, err
	}

	changed, err := store.ReconcileCodebuddyUsageBatch(ctx, records)
	if err != nil {
		return fileScanOutcome{}, err
	}
	if len(outcomes) > 0 {
		_, _ = store.InsertNativeOutcomes(ctx, outcomes)
	}

	provSet := make(map[string]struct{})
	provSet[file.Provider] = struct{}{}
	for _, r := range records {
		provSet[r.Provider] = struct{}{}
	}
	for _, p := range prompts {
		provSet[p.Provider] = struct{}{}
	}

	totalPrompts := 0
	var sessList []UsageSessionInput
	for prov := range provSet {
		var filtered []UsagePromptEventInput
		for _, p := range prompts {
			if p.Provider == prov {
				filtered = append(filtered, p)
			}
		}
		pIns, _ := store.InsertPromptEvents(ctx, filtered)
		totalPrompts += pIns
		sessList = append(sessList, UsageSessionInput{
			Provider:    prov,
			SessionID:   file.SessionID,
			CWD:         cwd,
			Project:     inferProjectFromCwd(cwd, file.ProjectDirName),
			StartedAtMS: startedAtMS,
			UpdatedAtMS: updatedAtMS,
			PromptCount: pIns,
		})
	}
	if len(sessList) > 0 {
		_, _ = store.UpsertSessions(ctx, sessList)
	}

	saveOffset := readRes.Offset
	if readRes.HadTrailingLine {
		saveOffset = readRes.TrailingLineStart
	}
	if err := store.SetFileState(ctx, file.FilePath, UsageFileState{
		Size:   stat.Size(),
		Offset: saveOffset,
		ScanContext: map[string]any{
			"codebuddyUsageProjectionVersion": codebuddyProjectionVersion,
			"identity":                        identity,
			"ino":                             file.Ino,
			"mtimeMs":                         mtimeMS,
			"cwd":                             cwd,
			"startedAtMs":                     startedAtMS,
			"updatedAtMs":                     updatedAtMS,
			"latestScope":                     activeScope,
		},
	}); err != nil {
		return fileScanOutcome{}, err
	}
	return fileScanOutcome{Records: changed, Prompts: totalPrompts}, nil
}

// ---------- CodeBuddy IDE scanner (desktop_history) ----------

type codebuddyIdeSource struct {
	Home       string
	Provider   string
	AccountRef string
	UserID     string
	Root       string
}

type codebuddyIdeSessionMeta struct {
	codebuddyIdeSource
	SessionID      string
	IndexPath      string
	ProjectDirName string
	CWD            string
	Title          string
	CreatedAt      int64
	UpdatedAt      int64
}

func resolveCodebuddyExtensionDataRoot(homeDir, platform string) string {
	plat := strings.ToLower(strings.TrimSpace(platform))
	if plat == "" {
		plat = runtime.GOOS
	}
	switch plat {
	case "darwin":
		return filepath.Join(homeDir, "Library", "Application Support", "CodeBuddyExtension", "Data")
	case "windows", "win32":
		return filepath.Join(homeDir, "AppData", "Local", "CodeBuddyExtension", "Data")
	default:
		return filepath.Join(homeDir, ".local", "share", "CodeBuddyExtension", "Data")
	}
}

func isRegularNoSymlinkJSONWithin(filePath string) bool {
	lst, err := os.Lstat(filePath)
	if err != nil || !lst.Mode().IsRegular() || lst.Mode()&os.ModeSymlink != 0 || lst.Size() > 8*1024*1024 {
		return false
	}
	phys, err := filepath.EvalSymlinks(filePath)
	if err != nil {
		return false
	}
	return filepath.Clean(phys) == filepath.Clean(filePath) || filepath.Base(phys) == filepath.Base(filePath)
}

func readCodebuddyIdeMetadata(ctx context.Context, home string) map[string]map[string]any {
	out := make(map[string]map[string]any)
	vscdb := filepath.Join(home, "electron-user-data", "codebuddy-sessions.vscdb")
	if !pathExists(vscdb) {
		return out
	}
	if lst, err := os.Lstat(vscdb); err != nil || lst.Mode()&os.ModeSymlink != 0 {
		return out
	}
	db, err := sql.Open("sqlite", buildReadOnlySQLiteDSN(vscdb))
	if err != nil {
		return out
	}
	defer func() { _ = db.Close() }()
	rows, err := db.QueryContext(ctx, `SELECT key, value FROM ItemTable WHERE key GLOB 'session:*'`)
	if err != nil {
		return out
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var k, v string
		if rows.Scan(&k, &v) != nil {
			continue
		}
		if entry := safeParseJSONMap(v); entry != nil {
			if cid := strVal(entry, "conversationId"); codebuddyHex32Re.MatchString(cid) {
				out[cid] = entry
			}
		}
	}
	return out
}

func scanCodebuddyIdeUsage(
	ctx context.Context,
	opts ScanUsageOptions,
	familyProviders []string,
	identities []codebuddyIdentityInfo,
) map[string]providerScanCounters {
	out := make(map[string]providerScanCounters)
	hasGlobal, hasCN := false, false
	for _, p := range familyProviders {
		if strings.HasSuffix(p, "cn") {
			hasCN = true
		} else {
			hasGlobal = true
		}
	}

	var sources []codebuddyIdeSource
	for _, id := range identities {
		if id.Provider != "codebuddy" && id.Provider != "codebuddycn" {
			continue
		}
		isCN := strings.HasSuffix(id.Provider, "cn")
		if (isCN && !hasCN) || (!isCN && !hasGlobal) {
			continue
		}
		homes := []string{}
		if opts.AIHomeDir != "" {
			homes = append(homes, filepath.Join(opts.AIHomeDir, "run", "auth-projections", id.Provider, id.AccountRef))
		}
		if opts.HostHomeDir != "" {
			homes = append(homes, opts.HostHomeDir)
		}
		for _, h := range homes {
			root := filepath.Join(resolveCodebuddyExtensionDataRoot(h, opts.Platform), id.UID, "CodeBuddyIDE", id.UID, "history")
			if st, err := os.Stat(root); err == nil && st.IsDir() {
				sources = append(sources, codebuddyIdeSource{
					Home:       h,
					Provider:   id.Provider,
					AccountRef: id.AccountRef,
					UserID:     id.UID,
					Root:       root,
				})
			}
		}
	}

	seenSessKey := make(map[string]struct{})
	var sessions []codebuddyIdeSessionMeta
	for _, src := range sources {
		metaMap := readCodebuddyIdeMetadata(ctx, src.Home)
		projects, err := os.ReadDir(src.Root)
		if err != nil {
			continue
		}
		for _, proj := range projects {
			if !proj.IsDir() || !codebuddyHex32Re.MatchString(proj.Name()) {
				continue
			}
			projRoot := filepath.Join(src.Root, proj.Name())
			titles := make(map[string]map[string]any)
			if pIdx := readJSONFileMap(filepath.Join(projRoot, "index.json")); pIdx != nil {
				if convs, ok := pIdx["conversations"].([]any); ok {
					for _, item := range convs {
						if m, ok := item.(map[string]any); ok {
							if cid := strVal(m, "id"); codebuddyHex32Re.MatchString(cid) {
								titles[cid] = m
							}
						}
					}
				}
			}
			sessDirs, err := os.ReadDir(projRoot)
			if err != nil {
				continue
			}
			for _, sd := range sessDirs {
				if !sd.IsDir() || !codebuddyHex32Re.MatchString(sd.Name()) {
					continue
				}
				if opts.CodebuddySessionID != "" && sd.Name() != opts.CodebuddySessionID {
					continue
				}
				idxPath := filepath.Join(projRoot, sd.Name(), "index.json")
				if !pathExists(idxPath) {
					continue
				}
				sk := idxPath + ":" + src.Provider + ":" + src.AccountRef
				if _, dup := seenSessKey[sk]; dup {
					continue
				}
				seenSessKey[sk] = struct{}{}
				nat := metaMap[sd.Name()]
				if nat != nil && strVal(nat, "userId") != "" && strVal(nat, "userId") != src.UserID {
					continue
				}
				tit := titles[sd.Name()]
				created := firstPosInt64(toTimestampMS(nat["createdAt"]), toTimestampMS(tit["createdAt"]))
				updNat := toTimestampMS(nat["updatedAt"])
				updTit := toTimestampMS(tit["lastMessageAt"])
				if updTit > updNat {
					updNat = updTit
				}
				title := strVal(nat, "title")
				if title == "" {
					title = strVal(tit, "name")
				}
				sessions = append(sessions, codebuddyIdeSessionMeta{
					codebuddyIdeSource: src,
					SessionID:          sd.Name(),
					IndexPath:          idxPath,
					ProjectDirName:     "ide-" + proj.Name(),
					CWD:                strVal(nat, "cwd"),
					Title:              title,
					CreatedAt:          created,
					UpdatedAt:          updNat,
				})
			}
		}
	}

	recordsByEvent := make(map[string]*UsageRecordInput)
	for _, sess := range sessions {
		cnt := out[sess.Provider]
		if !isRegularNoSymlinkJSONWithin(sess.IndexPath) {
			cnt.Skipped++
			out[sess.Provider] = cnt
			continue
		}
		idxMap := readJSONFileMap(sess.IndexPath)
		if idxMap == nil {
			cnt.Skipped++
			out[sess.Provider] = cnt
			continue
		}
		rawMsgs, ok1 := idxMap["messages"].([]any)
		rawReqs, ok2 := idxMap["requests"].([]any)
		if !ok1 || !ok2 {
			cnt.Skipped++
			out[sess.Provider] = cnt
			continue
		}

		msgMap := make(map[string]map[string]any)
		var promptEvents []UsagePromptEventInput
		var maxMsgTS, minUserTS int64
		region := "global"
		if strings.HasSuffix(sess.Provider, "cn") {
			region = "cn"
		}
		prefix := "codebuddy:ide-request:" + StableHash(region+":"+sess.SessionID) + ":"

		for _, refItem := range rawMsgs {
			rm, ok := refItem.(map[string]any)
			if !ok {
				continue
			}
			mid := strVal(rm, "id")
			if !codebuddyHex32Re.MatchString(mid) {
				continue
			}
			msgFile := filepath.Join(filepath.Dir(sess.IndexPath), "messages", mid+".json")
			if !isRegularNoSymlinkJSONWithin(msgFile) {
				continue
			}
			mObj := readJSONFileMap(msgFile)
			if mObj == nil || strVal(mObj, "id") != mid {
				continue
			}
			role := strVal(mObj, "role")
			if role != "user" && role != "assistant" {
				continue
			}
			extraMap := map[string]any{}
			if extraRaw, ok := mObj["extra"].(string); ok {
				if p := safeParseJSONMap(extraRaw); p != nil {
					extraMap = p
				}
			}
			mObj["_extra"] = extraMap
			tsMS := toTimestampMS(mObj["createdAt"])
			mObj["_tsMS"] = tsMS
			if tsMS > maxMsgTS {
				maxMsgTS = tsMS
			}
			msgMap[mid] = mObj
			if role == "user" && tsMS > 0 {
				if minUserTS == 0 || tsMS < minUserTS {
					minUserTS = tsMS
				}
				promptEvents = append(promptEvents, UsagePromptEventInput{
					EventKey:    prefix + StableHash(mid) + ":prompt",
					Provider:    sess.Provider,
					SessionID:   sess.SessionID,
					TimestampMS: tsMS,
				})
			}
		}

		cnt.Files++
		for _, reqItem := range rawReqs {
			req, ok := reqItem.(map[string]any)
			if !ok || strVal(req, "state") != "complete" {
				continue
			}
			reqID := strVal(req, "id")
			if !codebuddyHex32Re.MatchString(reqID) {
				continue
			}
			usageMap := mapVal(req, "usage")
			inTok, hasIn := floatValPtr(usageMap["inputTokens"])
			outTok, hasOut := floatValPtr(usageMap["outputTokens"])
			totTok, hasTot := floatValPtr(usageMap["totalTokens"])
			if !hasIn || !hasOut || !hasTot {
				continue
			}
			inInt := int64(inTok)
			outInt := int64(outTok)
			totInt := int64(totTok)
			if inInt < 0 || outInt < 0 || inInt+outInt <= 0 || totInt != inInt+outInt {
				continue
			}
			cacheRead := minInt64Val(inInt, int64FromMap(usageMap, "cacheTokens"))
			cacheCreation := minInt64Val(inInt-cacheRead, int64FromMap(usageMap, "cachedWriteTokens"))

			var lastAssistant map[string]any
			if reqMsgs, ok := req["messages"].([]any); ok {
				for _, rmID := range reqMsgs {
					if idStr, ok := rmID.(string); ok {
						if mm := msgMap[idStr]; mm != nil && strVal(mm, "role") == "assistant" {
							lastAssistant = mm
						}
					}
				}
			}
			if lastAssistant == nil {
				continue
			}
			model := strVal(mapVal(lastAssistant, "_extra"), "modelId")
			tsMS, _ := lastAssistant["_tsMS"].(int64)
			if tsMS == 0 {
				tsMS = toTimestampMS(req["startedAt"])
			}
			if model == "" || tsMS <= 0 {
				continue
			}

			ek := prefix + StableHash(reqID) + ":usage"
			prev, hasPrev, _ := opts.Store.ReadUsageOwnerByEventKey(ctx, ek)
			if rec, dup := recordsByEvent[ek]; dup {
				if (!hasPrev || prev.AccountRef == "") && rec.AccountRef != sess.AccountRef {
					rec.AccountRef = ""
				}
				continue
			}
			provOut := sess.Provider
			refOut := sess.AccountRef
			if hasPrev && prev.AccountRef != "" {
				provOut = prev.Provider
				refOut = prev.AccountRef
			}
			recordsByEvent[ek] = &UsageRecordInput{
				EventKey:                 ek,
				Provider:                 provOut,
				AccountRef:               refOut,
				SourceKind:               "desktop_history",
				SessionID:                sess.SessionID,
				RequestID:                reqID,
				Model:                    model,
				InputTokens:              maxInt64Zero(inInt - cacheRead - cacheCreation),
				OutputTokens:             outInt,
				CacheReadInputTokens:     cacheRead,
				CacheCreationInputTokens: cacheCreation,
				TotalTokens:              totInt,
				TimestampMS:              tsMS,
				CWD:                      sess.CWD,
				Project:                  inferProjectFromCwd(sess.CWD, sess.ProjectDirName),
			}
		}

		pIns, _ := opts.Store.InsertPromptEvents(ctx, promptEvents)
		cnt.Prompts += pIns
		startTS := firstPosInt64(sess.CreatedAt, minUserTS)
		updTS := maxInt64(sess.UpdatedAt, maxMsgTS)
		_, _ = opts.Store.UpsertSessions(ctx, []UsageSessionInput{{
			Provider:    sess.Provider,
			SessionID:   sess.SessionID,
			CWD:         sess.CWD,
			Project:     inferProjectFromCwd(sess.CWD, sess.ProjectDirName),
			PromptCount: pIns,
			StartedAtMS: startTS,
			UpdatedAtMS: updTS,
		}})
		out[sess.Provider] = cnt
	}

	for prov := range out {
		var batch []UsageRecordInput
		for _, rec := range recordsByEvent {
			if rec.Provider == prov {
				batch = append(batch, *rec)
			}
		}
		if len(batch) > 0 {
			changed, _ := opts.Store.ReconcileCodebuddyUsageBatch(ctx, batch)
			cnt := out[prov]
			cnt.Records += changed
			out[prov] = cnt
		}
	}

	return out
}
