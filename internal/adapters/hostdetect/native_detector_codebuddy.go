package hostdetect

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha1"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"golang.org/x/crypto/pbkdf2"
	_ "modernc.org/sqlite"
)

const (
	codebuddyDesktopSecretKey = `secret://{"extensionId":"tencent-cloud.coding-copilot","key":"planning-genie.new.accessToken"}`
	maxCodebuddyScanDirs      = 256
	maxVolumeRoots            = 16
	workbuddyCodecTimeout     = 30 * time.Second
	keychainLookupTimeout     = 5 * time.Second
	dpapiTimeout              = 5 * time.Second
)

var (
	codebuddyFamilyProviders = []string{"codebuddy", "codebuddycn", "workbuddy", "workbuddycn"}
	codebuddyAuthFileNames   = map[string]string{
		"codebuddy":   "Tencent-Cloud.coding-copilot.info",
		"codebuddycn": "workbuddy-desktop.info",
		"workbuddy":   "workbuddy-desktop-ai.info",
		"workbuddycn": "workbuddy-desktop.info",
	}
	codebuddyCrossSiteFallback = map[string]string{
		"codebuddycn": "codebuddy",
		"workbuddycn": "codebuddy",
	}
	codebuddyDesktopAppNames = map[string]string{
		"codebuddy":   "CodeBuddy",
		"codebuddycn": "CodeBuddy CN",
	}
	codebuddyDeclaredDesktopNames = map[string]bool{
		"CodeBuddy":    true,
		"CodeBuddy CN": true,
		"WorkBuddy":    true,
		"WorkBuddy AI": true,
	}
	codebuddyIssuers = map[string][]string{
		"https://www.codebuddy.ai/auth/realms/copilot":    {"codebuddy"},
		"https://www.workbuddy.ai/auth/realms/copilot":    {"workbuddy"},
		"https://www.workbuddy.cn/auth/realms/copilot":    {"codebuddycn", "workbuddycn"},
		"https://www.codebuddy.cn/auth/realms/copilot":    {"codebuddycn", "workbuddycn"},
		"https://copilot.tencent.com/auth/realms/copilot": {"codebuddycn", "workbuddycn"},
	}
)

type codebuddyScanSource struct {
	file           string
	provider       string
	decodeProvider string
	host           bool
	desktopHome    string
	accountRef     accountcore.AccountRef
}

type codebuddyInspection struct {
	ok          bool
	reason      string
	uid         string
	issuer      string
	domain      string
	providers   []string
	scope       string
	expiresAtMS int64
	hostID      string
	cred        map[string]any
	displayName string
}

func (s *detectSession) detectCodebuddyFamily() bool {
	platform := s.detector.normalizePlatform()
	if platform == "" {
		return true
	}

	overviews, err := s.listAllOverviews()
	if err != nil {
		return false
	}

	familyOverviews := make([]accountapp.AccountOverview, 0)
	for _, ov := range overviews {
		if isCodebuddyFamilyProvider(ov.Account().ProviderID()) {
			familyOverviews = append(familyOverviews, ov)
		}
	}

	sources := make([]codebuddyScanSource, 0)
	seenKeys := map[string]struct{}{}
	addSource := func(key string, src codebuddyScanSource) {
		if _, exists := seenKeys[key]; exists {
			return
		}
		seenKeys[key] = struct{}{}
		sources = append(sources, src)
	}

	for _, provider := range codebuddyFamilyProviders {
		for _, file := range s.detector.familyAuthPaths(s.hostHomeDir, provider, platform) {
			addSource("file:"+file, codebuddyScanSource{
				file:           file,
				host:           true,
				decodeProvider: provider,
			})
		}
		if provider == "codebuddy" || provider == "codebuddycn" {
			addSource("desktop:"+provider+":"+s.hostHomeDir, codebuddyScanSource{
				provider:    provider,
				desktopHome: s.hostHomeDir,
			})
		}
		for _, ov := range familyOverviews {
			if ov.Account().ProviderID() != provider {
				continue
			}
			ref := ov.Account().Ref()
			for _, projHome := range []string{
				filepath.Join(s.aiHomeDir, "accounts", provider, ref.String()),
				filepath.Join(s.aiHomeDir, "run", "auth-projections", provider, ref.String()),
			} {
				for _, file := range s.detector.familyAuthPaths(projHome, provider, platform) {
					addSource("file:"+file, codebuddyScanSource{
						file:           file,
						provider:       provider,
						decodeProvider: provider,
						accountRef:     ref,
					})
				}
				if provider == "codebuddy" || provider == "codebuddycn" {
					addSource("desktop:"+provider+":"+projHome, codebuddyScanSource{
						provider:    provider,
						desktopHome: projHome,
						accountRef:  ref,
					})
				}
			}
		}
	}

	decodedInfoCache := map[string]map[string]any{}
	existingScopes := s.loadExistingFamilyScopes(familyOverviews)

	for _, source := range sources {
		if s.ctx.Err() != nil {
			break
		}
		var (
			label      string
			inspection codebuddyInspection
		)
		if source.file != "" {
			label = filepath.Base(source.file)
			inspection = s.readCodebuddyInfoSource(source, platform, decodedInfoCache)
		} else {
			label = "desktop:" + source.provider
			inspection = s.readCodebuddyDesktopSource(source.desktopHome, source.provider, platform)
		}
		s.result.Scanned++
		if !inspection.ok {
			if inspection.reason != "credential_file_missing" && inspection.reason != "desktop_credential_unavailable" {
				s.addSkip(inspection.reason, source.provider, label, source.accountRef.String())
			}
			continue
		}
		if inspection.expiresAtMS > 0 && inspection.expiresAtMS <= s.detector.clock().UnixMilli() {
			s.addSkip("candidate_credential_expired", source.provider, label, source.accountRef.String())
			continue
		}

		targetProvider := source.provider
		if targetProvider == "" {
			if len(inspection.providers) == 1 {
				targetProvider = inspection.providers[0]
			} else if inspection.hostID == "workbuddy-desktop" {
				targetProvider = "workbuddycn"
			} else {
				targetProvider = "codebuddycn"
			}
		}
		if !s.detector.hostIDAllowedForProvider(s.hostHomeDir, targetProvider, platform, inspection.hostID) {
			s.addSkip("credential_source_mismatch", targetProvider, label, "")
			continue
		}

		type familyTarget struct {
			provider   string
			accountRef accountcore.AccountRef
		}
		targets := []familyTarget{{provider: targetProvider, accountRef: source.accountRef}}
		for _, match := range existingScopes[inspection.scope] {
			if match.provider != targetProvider {
				targets = append(targets, familyTarget{provider: match.provider, accountRef: match.accountRef})
			}
		}

		for _, target := range targets {
			envelope, envErr := marshalNativeAuthEnvelope(map[string]any{"credentials": inspection.cred})
			if envErr != nil {
				s.addSkip("codebuddy_credential_sync_failed", target.provider, label, target.accountRef.String())
				continue
			}
			cred, profile, decodeErr := s.detector.decoder.Decode(target.provider, envelope)
			clear(envelope)
			if decodeErr != nil || cred == nil {
				s.addSkip("identity_unverifiable", target.provider, label, target.accountRef.String())
				continue
			}
			s.adoptNewOrNewer(target.provider, label, cred, profile, inspection.displayName, target.accountRef)
		}
	}
	return true
}

type scopeRecord struct {
	provider   string
	accountRef accountcore.AccountRef
}

func (s *detectSession) loadExistingFamilyScopes(overviews []accountapp.AccountOverview) map[string][]scopeRecord {
	out := map[string][]scopeRecord{}
	for _, ov := range overviews {
		provider := ov.Account().ProviderID()
		snap, err := s.store.GetCredentialSnapshot(s.ctx, ov.Account().Ref())
		if err != nil {
			continue
		}
		nativeCred, ok := snap.Credential().(*accountcore.NativeCredential)
		if !ok || nativeCred == nil {
			continue
		}
		var doc map[string]any
		if json.Unmarshal(nativeCred.Payload(), &doc) != nil {
			continue
		}
		inner, _ := doc["credentials"].(map[string]any)
		if inner == nil {
			inner = doc
		}
		checked := inspectCodebuddyCredential(inner, provider, s.detector.clock().UnixMilli())
		if checked.ok && checked.scope != "" {
			out[checked.scope] = append(out[checked.scope], scopeRecord{
				provider:   provider,
				accountRef: ov.Account().Ref(),
			})
		}
	}
	return out
}

func (s *detectSession) readCodebuddyInfoSource(
	source codebuddyScanSource,
	platform string,
	cache map[string]map[string]any,
) codebuddyInspection {
	// 宿主文件经过文件边界守卫（普通文件、非软链、<=1MiB），投影目录跳过 aiHomeDir 路径限制。
	var guard *hostSelfWriteGuard
	if source.host {
		guard = s.guard
	}
	raw, reason, present := readGuardedRegularFile(source.file, guard)
	if !present {
		return codebuddyInspection{reason: "credential_file_missing"}
	}
	if reason != "" {
		return codebuddyInspection{reason: reason}
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed == nil {
		return codebuddyInspection{reason: "host_credential_file_corrupt"}
	}
	if hasWorkbuddyEncryptedFields(parsed) {
		sum := sha256.Sum256(raw)
		decodeProvider := source.decodeProvider
		if decodeProvider == "" {
			decodeProvider = "workbuddycn"
		}
		cacheKey := decodeProvider + ":" + hex.EncodeToString(sum[:])
		if cached, ok := cache[cacheKey]; ok {
			parsed = cached
		} else {
			decodedBytes, err := s.detector.decodeWorkbuddyEncrypted(s.ctx, raw, decodeProvider, platform, s.hostHomeDir)
			if err != nil {
				return codebuddyInspection{reason: err.Error()}
			}
			var decodedObj map[string]any
			if json.Unmarshal(decodedBytes, &decodedObj) != nil || decodedObj == nil {
				return codebuddyInspection{reason: "encrypted_credential_decode_failed"}
			}
			cache[cacheKey] = decodedObj
			parsed = decodedObj
		}
	}
	inspected := inspectCodebuddyCredential(parsed, source.provider, s.detector.clock().UnixMilli())
	if !inspected.ok {
		return inspected
	}
	inspected.hostID = strings.TrimSuffix(filepath.Base(source.file), ".info")
	return inspected
}

func hasWorkbuddyEncryptedFields(doc map[string]any) bool {
	if doc == nil {
		return false
	}
	if auth, _ := doc["auth"].(map[string]any); auth != nil {
		for _, field := range []string{"accessToken", "refreshToken", "idToken"} {
			if m, _ := auth[field].(map[string]any); m != nil {
				if v, ok := asInt(m["$wbEncrypted"]); ok && v == 1 {
					return true
				}
			}
		}
	}
	if account, _ := doc["account"].(map[string]any); account != nil {
		for _, field := range []string{"nickname", "phoneNumber"} {
			if m, _ := account[field].(map[string]any); m != nil {
				if v, ok := asInt(m["$wbEncrypted"]); ok && v == 1 {
					return true
				}
			}
		}
	}
	return false
}

func (detector *NativeDetector) decodeWorkbuddyEncrypted(
	ctx context.Context,
	rawJSON []byte,
	provider string,
	platform string,
	hostHome string,
) ([]byte, error) {
	if detector.options.DecodeWorkbuddy != nil {
		return detector.options.DecodeWorkbuddy(ctx, rawJSON, provider)
	}
	if provider != "workbuddy" && provider != "workbuddycn" {
		return nil, errors.New("unsupported_encrypted_credential")
	}
	electronPath := detector.resolveVendorElectron(provider, hostHome, platform)
	if electronPath == "" {
		return nil, errors.New("encrypted_credential_runtime_missing")
	}
	scriptPath := detector.resolveWorkbuddyCodecScript()
	if scriptPath == "" {
		return nil, errors.New("encrypted_credential_runtime_missing")
	}
	var rawObj json.RawMessage = bytes.TrimSpace(rawJSON)
	payload, err := json.Marshal(struct {
		Value     json.RawMessage `json:"value"`
		Operation string          `json:"operation"`
	}{
		Value:     rawObj,
		Operation: "decode",
	})
	if err != nil || len(payload) > maxDetectorArtifactBytes {
		return nil, errors.New("encrypted_credential_too_large")
	}
	runCtx, cancel := context.WithTimeout(ctx, workbuddyCodecTimeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, electronPath, scriptPath)
	cmd.Stdin = bytes.NewReader(payload)
	cmd.Env = append(os.Environ(), "ELECTRON_RUN_AS_NODE=1")
	out, err := cmd.Output()
	if err != nil {
		return nil, errors.New("encrypted_credential_decode_failed")
	}
	return out, nil
}

func (detector *NativeDetector) resolveWorkbuddyCodecScript() string {
	if custom := strings.TrimSpace(detector.options.CodecScriptPath); custom != "" {
		if st, err := os.Stat(custom); err == nil && st.Mode().IsRegular() {
			return custom
		}
	}
	rel := filepath.Join("scripts", "aih-workbuddy-credential-codec.cjs")
	wd, err := os.Getwd()
	if err != nil {
		return ""
	}
	dir := wd
	for i := 0; i < 6; i++ {
		candidate := filepath.Join(dir, rel)
		if st, statErr := os.Stat(candidate); statErr == nil && st.Mode().IsRegular() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}

func (detector *NativeDetector) resolveVendorElectron(provider, hostHome, platform string) string {
	if custom := strings.TrimSpace(detector.options.VendorElectron); custom != "" {
		if info, err := os.Stat(custom); err == nil && !info.IsDir() {
			return custom
		}
	}
	if platform != "darwin" {
		return ""
	}
	appName := "WorkBuddy.app"
	if provider == "workbuddy" {
		appName = "WorkBuddy AI.app"
	}
	candidates := []string{
		filepath.Join("/Applications", appName, "Contents", "MacOS", "Electron"),
	}
	if hostHome != "" {
		candidates = append(candidates, filepath.Join(hostHome, "Applications", appName, "Contents", "MacOS", "Electron"))
	}
	for _, vol := range detector.mountedVolumeRoots(platform) {
		candidates = append(candidates, filepath.Join(vol, appName, "Contents", "MacOS", "Electron"))
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

func (detector *NativeDetector) mountedVolumeRoots(platform string) []string {
	if detector.options.VolumeRoots != nil {
		return detector.options.VolumeRoots
	}
	if platform != "darwin" {
		return nil
	}
	entries, err := os.ReadDir("/Volumes")
	if err != nil {
		return nil
	}
	roots := make([]string, 0, maxVolumeRoots)
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == "Macintosh HD" || strings.HasPrefix(entry.Name(), "com.apple.") {
			continue
		}
		roots = append(roots, filepath.Join("/Volumes", entry.Name()))
		if len(roots) >= maxVolumeRoots {
			break
		}
	}
	return roots
}

func (s *detectSession) readCodebuddyDesktopSource(homeDir, provider, platform string) codebuddyInspection {
	dbCandidates := s.detector.desktopStateDBPaths(homeDir, provider, platform)
	lastReason := "desktop_credential_unavailable"
	for _, candidate := range dbCandidates {
		info, err := os.Lstat(candidate.dbPath)
		if err != nil || !info.Mode().IsRegular() || (info.Mode()&os.ModeSymlink != 0) {
			continue
		}
		blob, found, readErr := readDesktopEncryptedBlob(s.ctx, candidate.dbPath)
		if readErr != nil || !found {
			continue
		}
		if len(blob) < 3 {
			lastReason = "desktop_credential_unsupported_format"
			continue
		}
		version := string(blob[:3])
		if version == "v11" {
			lastReason = "desktop_credential_keyring_unavailable"
			continue
		}
		if version != "v10" {
			lastReason = "desktop_credential_unsupported_format"
			continue
		}
		plaintext, decReason := s.detector.decryptDesktopBlob(s.ctx, blob[3:], candidate.serviceName, platform)
		if decReason != "" {
			lastReason = decReason
			continue
		}
		var doc map[string]any
		err = json.Unmarshal(plaintext, &doc)
		clear(plaintext)
		if err != nil || doc == nil {
			lastReason = "desktop_credential_unreadable"
			continue
		}
		inspected := inspectCodebuddyCredential(doc, provider, s.detector.clock().UnixMilli())
		if inspected.ok {
			if fileName := codebuddyAuthFileNames[provider]; fileName != "" {
				inspected.hostID = strings.TrimSuffix(fileName, ".info")
			}
			return inspected
		}
		lastReason = inspected.reason
	}
	return codebuddyInspection{reason: lastReason}
}

type desktopDBCandidate struct {
	dbPath      string
	serviceName string
}

func (detector *NativeDetector) desktopStateDBPaths(homeDir, provider, platform string) []desktopDBCandidate {
	appName := codebuddyDesktopAppNames[provider]
	if appName == "" {
		return nil
	}
	serviceName := appName + " Safe Storage"
	out := make([]desktopDBCandidate, 0)
	seen := map[string]struct{}{}
	addDir := func(dir, svc string) {
		if dir == "" {
			return
		}
		dbPath := filepath.Join(dir, "User", "globalStorage", "state.vscdb")
		if _, ok := seen[dbPath]; ok {
			return
		}
		seen[dbPath] = struct{}{}
		out = append(out, desktopDBCandidate{dbPath: dbPath, serviceName: svc})
	}

	lookup := detector.lookupEnvFunc()
	if envDir, ok := lookup("ELECTRON_USER_DATA_DIR"); ok && strings.TrimSpace(envDir) != "" {
		addDir(strings.TrimSpace(envDir), serviceName)
	}
	if homeDir != "" {
		addDir(filepath.Join(homeDir, "electron-user-data"), serviceName)
		if parentSegs := userDataParentSegments(platform); len(parentSegs) > 0 {
			parentDir := filepath.Join(append([]string{homeDir}, parentSegs...)...)
			addDir(filepath.Join(parentDir, appName), serviceName)
		}
	}

	userDataRoots := detector.options.UserDataRoots
	if userDataRoots == nil && homeDir != "" {
		if parentSegs := userDataParentSegments(platform); len(parentSegs) > 0 {
			userDataRoots = []string{filepath.Join(append([]string{homeDir}, parentSegs...)...)}
		}
	}
	for _, root := range userDataRoots {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		count := 0
		for _, entry := range entries {
			if count >= maxCodebuddyScanDirs {
				break
			}
			if !entry.IsDir() || codebuddyDeclaredDesktopNames[entry.Name()] {
				continue
			}
			count++
			addDir(filepath.Join(root, entry.Name()), entry.Name()+" Safe Storage")
		}
	}
	return out
}

func readDesktopEncryptedBlob(ctx context.Context, dbPath string) ([]byte, bool, error) {
	dsn := (&url.URL{
		Scheme:   "file",
		Path:     filepath.ToSlash(dbPath),
		RawQuery: "mode=ro",
	}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = db.Close() }()

	var rawVal []byte
	err = db.QueryRowContext(ctx, "SELECT value FROM ItemTable WHERE key = ?", codebuddyDesktopSecretKey).Scan(&rawVal)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var bufferDoc struct {
		Type string `json:"type"`
		Data []byte `json:"data"`
	}
	if json.Unmarshal(rawVal, &bufferDoc) == nil && len(bufferDoc.Data) > 0 {
		return bufferDoc.Data, true, nil
	}
	return rawVal, true, nil
}

func (detector *NativeDetector) decryptDesktopBlob(
	ctx context.Context,
	ciphertext []byte,
	serviceName string,
	platform string,
) ([]byte, string) {
	switch platform {
	case "win32":
		if detector.options.DPAPIUnprotect != nil {
			plain, err := detector.options.DPAPIUnprotect(ctx, ciphertext)
			if err != nil || len(plain) == 0 {
				return nil, "desktop_credential_unreadable"
			}
			return plain, ""
		}
		plain, err := runWindowsDPAPIUnprotect(ctx, ciphertext)
		if err != nil || len(plain) == 0 {
			return nil, "desktop_credential_unreadable"
		}
		return plain, ""
	case "linux":
		plain, err := aesCBCDecryptPBKDF2(ciphertext, []byte("peanuts"), 1)
		if err != nil {
			return nil, "desktop_credential_unreadable"
		}
		return plain, ""
	case "darwin":
		var password []byte
		if detector.options.ReadKeychain != nil {
			pw, err := detector.options.ReadKeychain(serviceName)
			if err != nil || len(pw) == 0 {
				return nil, "desktop_credential_unreadable"
			}
			password = pw
		} else {
			pw, err := readMacKeychainPassword(ctx, serviceName)
			if err != nil || len(pw) == 0 {
				return nil, "desktop_credential_unreadable"
			}
			password = pw
		}
		defer clear(password)
		plain, err := aesCBCDecryptPBKDF2(ciphertext, password, 1003)
		if err != nil {
			return nil, "desktop_credential_unreadable"
		}
		return plain, ""
	default:
		return nil, "desktop_credential_unsupported_platform"
	}
}

func readMacKeychainPassword(ctx context.Context, service string) ([]byte, error) {
	runCtx, cancel := context.WithTimeout(ctx, keychainLookupTimeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, "/usr/bin/security", "find-generic-password", "-w", "-s", service)
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	trimmed := bytes.TrimRight(out, "\r\n")
	if len(trimmed) == 0 {
		return nil, errors.New("钥匙串密码为空")
	}
	return trimmed, nil
}

func runWindowsDPAPIUnprotect(ctx context.Context, ciphertext []byte) ([]byte, error) {
	const script = `$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.Security; $raw = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($raw, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($plain))`
	runCtx, cancel := context.WithTimeout(ctx, dpapiTimeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.Stdin = strings.NewReader(base64.StdEncoding.EncodeToString(ciphertext))
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(strings.TrimSpace(string(out)))
}

func aesCBCDecryptPBKDF2(ciphertext, password []byte, iterations int) ([]byte, error) {
	if len(ciphertext) == 0 || len(ciphertext)%aes.BlockSize != 0 {
		return nil, errors.New("AES 密文长度无效")
	}
	key := pbkdf2.Key(password, []byte("saltysalt"), iterations, 16, sha1.New)
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	iv := bytes.Repeat([]byte{0x20}, aes.BlockSize)
	plain := make([]byte, len(ciphertext))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plain, ciphertext)
	return unpadPKCS7(plain, aes.BlockSize)
}

func unpadPKCS7(data []byte, blockSize int) ([]byte, error) {
	if len(data) == 0 || len(data)%blockSize != 0 {
		return nil, errors.New("PKCS7 明文长度无效")
	}
	pad := int(data[len(data)-1])
	if pad == 0 || pad > blockSize || pad > len(data) {
		return nil, errors.New("PKCS7 填充字节无效")
	}
	for i := len(data) - pad; i < len(data); i++ {
		if int(data[i]) != pad {
			return nil, errors.New("PKCS7 填充字节无效")
		}
	}
	return data[:len(data)-pad], nil
}

func inspectCodebuddyCredential(value map[string]any, provider string, nowMS int64) codebuddyInspection {
	if value == nil {
		return codebuddyInspection{reason: "unsupported_credential_shape"}
	}
	auth, _ := value["auth"].(map[string]any)
	account, _ := value["account"].(map[string]any)
	if auth == nil || account == nil {
		return codebuddyInspection{reason: "unsupported_credential_shape"}
	}
	accessToken := firstString(auth, "accessToken", "access_token")
	refreshToken := firstString(auth, "refreshToken", "refresh_token")
	access := decodeJWTClaims(accessToken)
	refresh := decodeJWTClaims(refreshToken)
	if access == nil {
		return codebuddyInspection{reason: "unrecognized_credential_realm"}
	}
	issuer := firstString(access, "iss")
	providersForIssuer := codebuddyIssuers[issuer]
	if len(providersForIssuer) == 0 {
		return codebuddyInspection{reason: "unrecognized_credential_realm"}
	}
	if provider != "" && !containsString(providersForIssuer, provider) {
		return codebuddyInspection{reason: "credential_realm_mismatch"}
	}
	if refreshToken == "" {
		return codebuddyInspection{reason: "incomplete_oauth_credential"}
	}
	uid := firstString(account, "uid")
	subject := firstString(access, "sub")
	refreshSub := firstString(refresh, "sub")
	if uid == "" || uid != subject || hasControlOrWhitespace(uid) || (refreshSub != "" && refreshSub != uid) {
		return codebuddyInspection{reason: "credential_identity_mismatch"}
	}
	parsedIssuer, err := url.Parse(issuer)
	if err != nil || !strings.EqualFold(firstString(auth, "domain"), parsedIssuer.Hostname()) {
		return codebuddyInspection{reason: "credential_domain_mismatch"}
	}
	if refresh != nil {
		if refreshIss := firstString(refresh, "iss"); refreshIss != "" && refreshIss != issuer {
			return codebuddyInspection{reason: "refresh_realm_mismatch"}
		}
	}
	iatMS, hasIat := jwtEpochMS(access["iat"])
	expMS, hasExp := jwtEpochMS(access["exp"])
	if !hasIat || iatMS <= 0 || iatMS > nowMS+120000 || (hasExp && expMS < iatMS) {
		return codebuddyInspection{reason: "credential_time_invalid"}
	}
	displayName := firstString(account, "nickname", "email")
	if displayName == "" {
		displayName = firstString(access, "nickname", "email", "preferred_username")
	}
	return codebuddyInspection{
		ok:          true,
		uid:         uid,
		issuer:      issuer,
		domain:      parsedIssuer.Hostname(),
		providers:   providersForIssuer,
		scope:       issuer + "\n" + uid,
		expiresAtMS: expMS,
		cred:        value,
		displayName: displayName,
	}
}

func (detector *NativeDetector) familyAuthPaths(home, provider, platform string) []string {
	if home == "" || !isCodebuddyFamilyProvider(provider) {
		return nil
	}
	dir := resolveFamilyPublicAuthDir(home, platform)
	if dir == "" {
		return nil
	}
	primaryName := codebuddyAuthFileNames[provider]
	if primaryName == "" {
		return nil
	}
	paths := []string{filepath.Join(dir, primaryName)}
	if fallbackProvider, ok := codebuddyCrossSiteFallback[provider]; ok {
		if fallbackName := codebuddyAuthFileNames[fallbackProvider]; fallbackName != "" && fallbackName != primaryName {
			paths = append(paths, filepath.Join(dir, fallbackName))
		}
	}
	return paths
}

func (detector *NativeDetector) hostIDAllowedForProvider(home, provider, platform, hostID string) bool {
	if hostID == "" {
		return false
	}
	for _, p := range detector.familyAuthPaths(home, provider, platform) {
		if strings.TrimSuffix(filepath.Base(p), ".info") == hostID {
			return true
		}
	}
	return false
}

func resolveFamilyPublicAuthDir(home, platform string) string {
	parentSegs := userDataParentSegments(platform)
	if len(parentSegs) == 0 {
		return ""
	}
	segs := make([]string, 0, 1+len(parentSegs)+4)
	segs = append(segs, home)
	segs = append(segs, parentSegs...)
	segs = append(segs, "CodeBuddyExtension", "Data", "Public", "auth")
	return filepath.Join(segs...)
}

func userDataParentSegments(platform string) []string {
	switch platform {
	case "darwin":
		return []string{"Library", "Application Support"}
	case "win32":
		return []string{"AppData", "Local"}
	case "linux":
		return []string{".local", "share"}
	default:
		return nil
	}
}

func isCodebuddyFamilyProvider(provider string) bool {
	for _, item := range codebuddyFamilyProviders {
		if item == provider {
			return true
		}
	}
	return false
}

func containsString(items []string, target string) bool {
	for _, item := range items {
		if item == target {
			return true
		}
	}
	return false
}

func hasControlOrWhitespace(text string) bool {
	for _, r := range text {
		if r <= 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func jwtEpochMS(val any) (int64, bool) {
	switch n := val.(type) {
	case float64:
		if n > 0 {
			return int64(n * 1000), true
		}
	case int64:
		if n > 0 {
			return n * 1000, true
		}
	case json.Number:
		if f, err := n.Float64(); err == nil && f > 0 {
			return int64(f * 1000), true
		}
	}
	return 0, false
}
