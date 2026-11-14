package webuiopenappapi

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/accounts/zcodecred"
)

const (
	zcodeManagedProxyMarkerFile    = ".aih-zcode-egress.json"
	zcodeManagedProxyMarkerVersion = 1
	zcodeDefaultNoProxy            = "localhost,127.0.0.1,::1"
	zcodeDesktopApplicationNameEnv = "ZCODE_DESKTOP_APPLICATION_NAME"
	zcodeAgentLauncherRelPath      = "zcode-agent-launcher.cjs"

	zcodeShadowLayoutVersion        = 4
	zcodeFuseSentinel               = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"
	zcodeEmbeddedAsarIntegrityIndex = 4
	zcodeOriginalMainPath           = "out/main/index.js"
	zcodeBootstrapEntryPath         = "node_modules/yaml/bin.mjs"
	zcodeYamlPackagePath            = "node_modules/yaml/package.json"
	zcodeBundledHookFilename        = "aih-zcode-captcha-hook.cjs"
	zcodeMaxAsarHeaderBytes         = 64 * 1024 * 1024
	zcodeAgentCwdEnvRef             = "process.env.ZCODE_AGENT_SERVER_CWD"
	zcodeAgentRuntimeReplacement    = "supportsStorageStartup:!0,storagePreparationEntry:e"
)

var (
	zcodeAgentCwdFieldPattern = regexp.MustCompile(
		`cwd:process\.env\.ZCODE_AGENT_SERVER_CWD\?\.trim\(\)\|\|[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*`,
	)
	zcodeUserInfoKeyPattern = regexp.MustCompile(`^oauth:([^:]+):user_info$`)
)

func currentOSUsername() string {
	if u, err := user.Current(); err == nil {
		return strings.TrimSpace(u.Username)
	}
	return strings.TrimSpace(os.Getenv("USER"))
}

type zcodeManagedProxyPair struct {
	HTTPProxy        string `json:"httpProxy"`
	HTTPProxyNoProxy string `json:"httpProxyNoProxy"`
}

type zcodeManagedProxyMarker struct {
	Version          int                     `json:"version"`
	HTTPProxy        string                  `json:"httpProxy"`
	HTTPProxyNoProxy string                  `json:"httpProxyNoProxy"`
	Restore          map[string]any          `json:"restore,omitempty"`
	Previous         []zcodeManagedProxyPair `json:"previous,omitempty"`
}

func toZcodeProxyURL(proxyServer string) string {
	val := strings.TrimSpace(proxyServer)
	if val == "" {
		return ""
	}
	if strings.Contains(val, "://") {
		return val
	}
	return "http://" + val
}

// applyZcodeNativeProxySettings 对标 Node prepareZcodeNativeProxySettings：
// 在 <profileDir>/.zcode/v2/setting.json 同步 httpProxy/httpProxyNoProxy，并用
// <profileDir>/.aih-zcode-egress.json 记录受管所有权；遇到无法识别的 marker 拒绝覆盖。
func applyZcodeNativeProxySettings(
	profileDir string,
	egress EgressResolution,
	rollback *fileRollback,
) (string, error) {
	profileRoot := strings.TrimSpace(profileDir)
	if profileRoot == "" {
		return "zcode_native_proxy_settings_failed", errors.New("profile_dir_empty")
	}
	settingsPath := filepath.Join(profileRoot, ".zcode", "v2", "setting.json")
	markerPath := filepath.Join(profileRoot, zcodeManagedProxyMarkerFile)
	if rollback != nil {
		rollback.snapshot(settingsPath, markerPath)
	}

	_, markerStatErr := os.Stat(markerPath)
	markerExists := markerStatErr == nil
	if markerStatErr != nil && !os.IsNotExist(markerStatErr) {
		return "zcode_native_proxy_settings_failed", markerStatErr
	}
	var prevMarker *zcodeManagedProxyMarker
	if markerExists {
		prevMarker = readZcodeManagedProxyMarker(markerPath)
		if prevMarker == nil {
			return "zcode_native_proxy_marker_unrecognized", errors.New("无法识别 ZCode 出口 marker；本次保留现有原生设置，账号出口变更未应用")
		}
	}

	httpProxy := ""
	if egress.OK && egress.Bound && !egress.Direct {
		httpProxy = toZcodeProxyURL(egress.ProxyServer)
	}
	if httpProxy == "" {
		if !markerExists {
			return "", nil
		}
		settings, err := readZcodeJSONObject(settingsPath)
		if err != nil {
			return "zcode_native_proxy_settings_failed", err
		}
		changed := false
		for _, key := range []string{"httpProxy", "httpProxyNoProxy"} {
			if zcodeMarkerOwnsKey(prevMarker, settings, key) {
				if prevMarker.Restore != nil {
					if val, exists := prevMarker.Restore[key]; exists {
						settings[key] = val
					} else {
						delete(settings, key)
					}
				} else {
					delete(settings, key)
				}
				changed = true
			}
		}
		if changed {
			if err := writeJSONAtomic(settingsPath, settings); err != nil {
				return "zcode_native_proxy_settings_failed", err
			}
		}
		if err := os.Remove(markerPath); err != nil && !os.IsNotExist(err) {
			return "zcode_native_proxy_settings_failed", err
		}
		return "", nil
	}

	settings, err := readZcodeJSONObject(settingsPath)
	if err != nil {
		return "zcode_native_proxy_settings_failed", err
	}
	pending := buildZcodeManagedProxyMarker(httpProxy, zcodeDefaultNoProxy, settings, prevMarker)
	if err := writeJSONAtomic(markerPath, pending); err != nil {
		return "zcode_native_proxy_settings_failed", err
	}
	settings["httpProxy"] = httpProxy
	settings["httpProxyNoProxy"] = zcodeDefaultNoProxy
	if err := writeJSONAtomic(settingsPath, settings); err != nil {
		return "zcode_native_proxy_settings_failed", err
	}
	if len(pending.Previous) > 0 {
		finalMarker := zcodeManagedProxyMarker{
			Version:          zcodeManagedProxyMarkerVersion,
			HTTPProxy:        httpProxy,
			HTTPProxyNoProxy: zcodeDefaultNoProxy,
			Restore:          pending.Restore,
		}
		if err := writeJSONAtomic(markerPath, finalMarker); err != nil {
			return "zcode_native_proxy_settings_failed", err
		}
	}
	return "", nil
}

func readZcodeJSONObject(filePath string) (map[string]any, error) {
	raw, err := os.ReadFile(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil
		}
		return nil, err
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return nil, errors.New("zcode_native_settings_not_object")
	}
	return obj, nil
}

func readZcodeManagedProxyMarker(markerPath string) *zcodeManagedProxyMarker {
	raw, err := os.ReadFile(markerPath)
	if err != nil {
		return nil
	}
	var rawMap map[string]any
	if err := json.Unmarshal(raw, &rawMap); err != nil || rawMap == nil {
		return nil
	}
	v, ok := rawMap["version"].(float64)
	if !ok || int(v) != zcodeManagedProxyMarkerVersion {
		return nil
	}
	httpProxy := strings.TrimSpace(stringField(rawMap, "httpProxy"))
	if httpProxy == "" {
		return nil
	}
	httpNoProxy, _ := rawMap["httpProxyNoProxy"].(string)
	httpNoProxy = strings.TrimSpace(httpNoProxy)
	cur := zcodeManagedProxyPair{HTTPProxy: httpProxy, HTTPProxyNoProxy: httpNoProxy}
	seen := map[string]struct{}{cur.HTTPProxy + "\n" + cur.HTTPProxyNoProxy: {}}
	owned := []zcodeManagedProxyPair{cur}
	if prevList, ok := rawMap["previous"].([]any); ok {
		for _, item := range prevList {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			p := strings.TrimSpace(stringField(m, "httpProxy"))
			if p == "" {
				continue
			}
			np, _ := m["httpProxyNoProxy"].(string)
			np = strings.TrimSpace(np)
			key := p + "\n" + np
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			owned = append(owned, zcodeManagedProxyPair{HTTPProxy: p, HTTPProxyNoProxy: np})
		}
	}
	var restore map[string]any
	if rMap, ok := rawMap["restore"].(map[string]any); ok {
		restore = map[string]any{}
		for _, key := range []string{"httpProxy", "httpProxyNoProxy"} {
			if val, exists := rMap[key]; exists {
				restore[key] = val
			}
		}
	}
	return &zcodeManagedProxyMarker{
		Version:          zcodeManagedProxyMarkerVersion,
		HTTPProxy:        httpProxy,
		HTTPProxyNoProxy: httpNoProxy,
		Restore:          restore,
		Previous:         owned,
	}
}

func zcodeMarkerOwnsKey(marker *zcodeManagedProxyMarker, settings map[string]any, key string) bool {
	if marker == nil || settings == nil {
		return false
	}
	currentVal, exists := settings[key]
	if !exists {
		return false
	}
	for _, candidate := range marker.Previous {
		var expected string
		if key == "httpProxy" {
			expected = candidate.HTTPProxy
		} else {
			expected = candidate.HTTPProxyNoProxy
		}
		if currentStr, ok := currentVal.(string); ok && currentStr == expected {
			return true
		}
	}
	return false
}

func buildZcodeManagedProxyMarker(
	httpProxy string,
	httpProxyNoProxy string,
	settings map[string]any,
	prev *zcodeManagedProxyMarker,
) zcodeManagedProxyMarker {
	restore := map[string]any{}
	for _, key := range []string{"httpProxy", "httpProxyNoProxy"} {
		stillManaged := zcodeMarkerOwnsKey(prev, settings, key)
		source := settings
		if stillManaged && prev != nil {
			source = prev.Restore
		}
		if source != nil {
			if val, exists := source[key]; exists {
				restore[key] = val
			}
		}
	}
	currentKey := httpProxy + "\n" + httpProxyNoProxy
	var previous []zcodeManagedProxyPair
	if prev != nil {
		for _, cand := range prev.Previous {
			if cand.HTTPProxy+"\n"+cand.HTTPProxyNoProxy == currentKey {
				continue
			}
			previous = append(previous, cand)
			if len(previous) >= 8 {
				break
			}
		}
	}
	return zcodeManagedProxyMarker{
		Version:          zcodeManagedProxyMarkerVersion,
		HTTPProxy:        httpProxy,
		HTTPProxyNoProxy: httpProxyNoProxy,
		Restore:          restore,
		Previous:         previous,
	}
}

func resolveZcodeSecretForHost(hostHomeDir string, environ []string) string {
	explicit := ""
	for _, entry := range environ {
		k, v, ok := strings.Cut(entry, "=")
		if ok && k == zcodecred.SecretEnv {
			explicit = v
			break
		}
	}
	platform := normalizeZcodeSecretPlatform()
	return zcodecred.ResolveSecret(explicit, platform, hostHomeDir, currentOSUsername())
}

// prepareZcodeShadowApp 在 macOS 上基于原版 ZCode.app 准备带 captcha hook 的隔离副本。
func prepareZcodeShadowApp(
	ctx context.Context,
	aiHomeDir string,
	repoRoot string,
	sourceBundlePath string,
	sourceExecutablePath string,
	runner CommandRunner,
) (bundlePath string, executablePath string, errCode string, err error) {
	if strings.TrimSpace(repoRoot) == "" || strings.TrimSpace(sourceBundlePath) == "" {
		return sourceBundlePath, sourceExecutablePath, "", nil
	}
	hookModulePath := filepath.Join(repoRoot, "lib", "runtime", zcodeBundledHookFilename)
	if info, statErr := os.Stat(hookModulePath); statErr != nil || info.IsDir() {
		return sourceBundlePath, sourceExecutablePath, "", nil
	}

	info, err := inspectZcodeSourceBundle(sourceBundlePath, sourceExecutablePath, hookModulePath)
	if err != nil {
		var codeErr *zcodeShadowError
		if errors.As(err, &codeErr) {
			return "", "", codeErr.code, codeErr
		}
		return "", "", "zcode_captcha_shadow_prepare_failed", err
	}

	shadowRoot := filepath.Join(aiHomeDir, "run", "zcode-shadow", info.fingerprint)
	shadowBundle := filepath.Join(shadowRoot, filepath.Base(sourceBundlePath))
	shadowAsar := filepath.Join(shadowBundle, "Contents", "Resources", "app.asar")
	shadowHook := filepath.Join(shadowBundle, "Contents", "Resources", zcodeBundledHookFilename)
	shadowExec := filepath.Join(shadowBundle, info.executableRelative)

	if verifyZcodeShadowBundle(shadowAsar, shadowHook, shadowExec, info) {
		return shadowBundle, shadowExec, "", nil
	}

	_ = os.RemoveAll(shadowRoot)
	if mkErr := os.MkdirAll(shadowRoot, 0o700); mkErr != nil {
		return "", "", "zcode_captcha_shadow_prepare_failed", mkErr
	}
	cpOut := runner.Run(ctx, "/bin/cp", []string{"-c", "-R", sourceBundlePath, shadowBundle}, RunOptions{Timeout: 60 * time.Second})
	if cpOut.Err != nil || cpOut.ExitCode != 0 {
		// APFS clonefile 跨卷时退回到普通递归拷贝。
		cpOut = runner.Run(ctx, "/bin/cp", []string{"-R", sourceBundlePath, shadowBundle}, RunOptions{Timeout: 90 * time.Second})
		if cpOut.Err != nil || cpOut.ExitCode != 0 {
			return "", "", "zcode_captcha_shadow_prepare_failed", fmt.Errorf("cp failed: %v %s", cpOut.Err, cpOut.Stderr)
		}
	}
	if err := writeBytesAtomic(shadowHook, info.hookContent, 0o644); err != nil {
		return "", "", "zcode_captcha_shadow_prepare_failed", err
	}
	if err := patchZcodeShadowAsar(shadowAsar, info); err != nil {
		return "", "", "zcode_captcha_shadow_prepare_failed", err
	}
	signOut := runner.Run(ctx, "/usr/bin/codesign", []string{"--force", "--sign", "-", shadowBundle}, RunOptions{Timeout: 30 * time.Second})
	if signOut.Err != nil || signOut.ExitCode != 0 {
		return "", "", "zcode_captcha_shadow_prepare_failed", fmt.Errorf("codesign failed: %v %s", signOut.Err, signOut.Stderr)
	}
	if _, statErr := os.Stat(shadowExec); statErr != nil {
		return "", "", "zcode_captcha_shadow_prepare_failed", statErr
	}
	return shadowBundle, shadowExec, "", nil
}

type zcodeShadowError struct {
	code string
	msg  string
}

func (e *zcodeShadowError) Error() string { return e.code + ": " + e.msg }

type asarIntegrity struct {
	Hash string `json:"hash"`
}

type asarEntry struct {
	Size      int64          `json:"size"`
	Offset    string         `json:"offset"`
	Integrity *asarIntegrity `json:"integrity"`
}

type asarHeaderNode struct {
	Files     map[string]asarHeaderNode `json:"files"`
	Size      int64                     `json:"size"`
	Offset    string                    `json:"offset"`
	Integrity *asarIntegrity            `json:"integrity"`
}

type asarResolvedEntry struct {
	Path           string
	Size           int64
	AbsoluteOffset int64
	IntegrityHash  string
}

type asarMetadata struct {
	HeaderHash string
	DataOffset int64
	Root       asarHeaderNode
}

type zcodeSourceInspection struct {
	asarPath           string
	bootstrapSource    string
	executableRelative string
	fingerprint        string
	hookHash           string
	hookContent        []byte
	metadata           asarMetadata
	packageJSON        map[string]any
	agentEntryPath     string
	agentCwdMatch      []byte
	agentEntry         asarResolvedEntry
}

func inspectZcodeSourceBundle(sourceBundlePath, sourceExecutablePath, hookModulePath string) (zcodeSourceInspection, error) {
	asarPath := filepath.Join(sourceBundlePath, "Contents", "Resources", "app.asar")
	frameworkPath := filepath.Join(
		sourceBundlePath, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Electron Framework",
	)
	wire, err := readElectronFuseWire(frameworkPath)
	if err != nil {
		return zcodeSourceInspection{}, err
	}
	if len(wire) <= zcodeEmbeddedAsarIntegrityIndex || wire[zcodeEmbeddedAsarIntegrityIndex] != '0' {
		return zcodeSourceInspection{}, &zcodeShadowError{code: "zcode_captcha_shadow_integrity_enabled", msg: "asar integrity fuse enabled"}
	}
	metadata, err := readAsarMetadata(asarPath)
	if err != nil {
		return zcodeSourceInspection{}, err
	}
	pkgEntry, pkgBytes, err := readAndVerifyAsarEntry(asarPath, metadata, "package.json")
	if err != nil {
		return zcodeSourceInspection{}, err
	}
	yamlPkgEntry, yamlPkgBytes, err := readAndVerifyAsarEntry(asarPath, metadata, zcodeYamlPackagePath)
	if err != nil {
		return zcodeSourceInspection{}, err
	}
	bootEntry, _, err := readAndVerifyAsarEntry(asarPath, metadata, zcodeBootstrapEntryPath)
	if err != nil {
		return zcodeSourceInspection{}, err
	}
	mainEntry, _, err := readAndVerifyAsarEntry(asarPath, metadata, zcodeOriginalMainPath)
	if err != nil {
		return zcodeSourceInspection{}, err
	}
	_ = yamlPkgEntry

	var pkgJSON map[string]any
	if err := json.Unmarshal(pkgBytes, &pkgJSON); err != nil {
		return zcodeSourceInspection{}, err
	}
	if pkgJSON["type"] != "module" || pkgJSON["main"] != zcodeOriginalMainPath {
		return zcodeSourceInspection{}, errors.New("unsupported_zcode_package_main")
	}
	var yamlPkg map[string]any
	if err := json.Unmarshal(yamlPkgBytes, &yamlPkg); err != nil {
		return zcodeSourceInspection{}, err
	}
	if !jsonContainsString(yamlPkg["bin"], "./bin.mjs") || jsonContainsString(yamlPkg["exports"], "./bin.mjs") {
		return zcodeSourceInspection{}, errors.New("unsafe_zcode_bootstrap_entry")
	}
	bootstrapSrc := fmt.Sprintf(
		"import{createRequire as r}from\"node:module\";r(import.meta.url)(\"../../../%s\");await import(\"../../out/main/index.js\");\n",
		zcodeBundledHookFilename,
	)
	if int64(len(bootstrapSrc)) > bootEntry.Size {
		return zcodeSourceInspection{}, errors.New("zcode_bootstrap_entry_too_small")
	}

	agentEntry, agentMatch, err := findAgentRuntimeEntry(asarPath, metadata)
	if err != nil {
		return zcodeSourceInspection{}, err
	}

	if strings.TrimSpace(sourceExecutablePath) == "" {
		sourceExecutablePath = filepath.Join(sourceBundlePath, "Contents", "MacOS", "ZCode")
	}
	relExec, err := filepath.Rel(sourceBundlePath, sourceExecutablePath)
	if err != nil || relExec == "" || strings.HasPrefix(relExec, "..") || filepath.IsAbs(relExec) {
		return zcodeSourceInspection{}, errors.New("invalid_zcode_executable_path")
	}
	hookContent, err := os.ReadFile(hookModulePath)
	if err != nil {
		return zcodeSourceInspection{}, err
	}
	hookHash := sha256Hex(hookContent)
	agentHash := sha256Hex(agentMatch)

	fpPayload, _ := json.Marshal(struct {
		Version       int    `json:"version"`
		HeaderHash    string `json:"headerHash"`
		PackageHash   string `json:"packageHash"`
		BootstrapHash string `json:"bootstrapHash"`
		MainHash      string `json:"mainHash"`
		AgentPath     string `json:"agentRuntimeEntryPath"`
		AgentHash     string `json:"agentRuntimeHash"`
		FuseWire      string `json:"fuseWire"`
		HookHash      string `json:"hookHash"`
		ExecRel       string `json:"executableRelativePath"`
	}{
		Version:       zcodeShadowLayoutVersion,
		HeaderHash:    metadata.HeaderHash,
		PackageHash:   pkgEntry.IntegrityHash,
		BootstrapHash: bootEntry.IntegrityHash,
		MainHash:      mainEntry.IntegrityHash,
		AgentPath:     agentEntry.Path,
		AgentHash:     agentHash,
		FuseWire:      wire,
		HookHash:      hookHash,
		ExecRel:       relExec,
	})
	fingerprint := sha256Hex(fpPayload)[:16]

	return zcodeSourceInspection{
		asarPath:           asarPath,
		bootstrapSource:    bootstrapSrc,
		executableRelative: relExec,
		fingerprint:        fingerprint,
		hookHash:           hookHash,
		hookContent:        hookContent,
		metadata:           metadata,
		packageJSON:        pkgJSON,
		agentEntryPath:     agentEntry.Path,
		agentCwdMatch:      agentMatch,
		agentEntry:         agentEntry,
	}, nil
}

func findAgentRuntimeEntry(asarPath string, metadata asarMetadata) (asarResolvedEntry, []byte, error) {
	candidates := collectAsarChunkPaths(metadata.Root, "")
	for _, entryPath := range candidates {
		if !strings.HasPrefix(entryPath, "out/main/") || !strings.HasSuffix(entryPath, ".js") {
			continue
		}
		entry, raw, err := readAndVerifyAsarEntry(asarPath, metadata, entryPath)
		if err != nil {
			continue
		}
		if loc := zcodeAgentCwdFieldPattern.Find(raw); loc != nil && strings.Contains(string(raw), zcodeAgentCwdEnvRef) {
			return entry, loc, nil
		}
	}
	return asarResolvedEntry{}, nil, errors.New("zcode_agent_runtime_anchor_missing")
}

func collectAsarChunkPaths(node asarHeaderNode, prefix string) []string {
	var out []string
	for name, child := range node.Files {
		next := name
		if prefix != "" {
			next = prefix + "/" + name
		}
		if len(child.Files) > 0 {
			out = append(out, collectAsarChunkPaths(child, next)...)
		} else {
			out = append(out, next)
		}
	}
	return out
}

func readElectronFuseWire(frameworkPath string) (string, error) {
	data, err := os.ReadFile(frameworkPath)
	if err != nil {
		return "", err
	}
	idx := strings.Index(string(data), zcodeFuseSentinel)
	if idx < 0 {
		return "", errors.New("electron_fuse_sentinel_missing")
	}
	pos := idx + len(zcodeFuseSentinel)
	if pos+2 >= len(data) {
		return "", errors.New("unsupported_electron_fuse_wire")
	}
	version := int(data[pos])
	wireLen := int(data[pos+1])
	if version != 1 || wireLen <= zcodeEmbeddedAsarIntegrityIndex || wireLen > 64 || pos+2+wireLen > len(data) {
		return "", errors.New("unsupported_electron_fuse_wire")
	}
	wire := string(data[pos+2 : pos+2+wireLen])
	for _, ch := range wire {
		if ch != '0' && ch != '1' && ch != 'r' {
			return "", errors.New("invalid_electron_fuse_wire")
		}
	}
	return wire, nil
}

func readAsarMetadata(asarPath string) (asarMetadata, error) {
	f, err := os.Open(asarPath)
	if err != nil {
		return asarMetadata{}, err
	}
	defer f.Close()
	prefix := make([]byte, 16)
	if _, err := io.ReadFull(f, prefix); err != nil {
		return asarMetadata{}, err
	}
	if binary.LittleEndian.Uint32(prefix[0:4]) != 4 {
		return asarMetadata{}, errors.New("invalid_asar_size_pickle")
	}
	headerSize := int64(binary.LittleEndian.Uint32(prefix[4:8]))
	headerPayloadSize := int64(binary.LittleEndian.Uint32(prefix[8:12]))
	headerJSONSize := int64(binary.LittleEndian.Uint32(prefix[12:16]))
	if headerSize < 12 || headerSize > zcodeMaxAsarHeaderBytes || headerPayloadSize+4 != headerSize || headerJSONSize > headerSize-8 {
		return asarMetadata{}, errors.New("invalid_asar_header_pickle")
	}
	headerBytes := make([]byte, headerJSONSize)
	if _, err := io.ReadFull(f, headerBytes); err != nil {
		return asarMetadata{}, err
	}
	var root asarHeaderNode
	if err := json.Unmarshal(headerBytes, &root); err != nil {
		return asarMetadata{}, err
	}
	return asarMetadata{
		HeaderHash: sha256Hex(headerBytes),
		DataOffset: 8 + headerSize,
		Root:       root,
	}, nil
}

func readAndVerifyAsarEntry(asarPath string, metadata asarMetadata, relPath string) (asarResolvedEntry, []byte, error) {
	node := metadata.Root
	parts := strings.Split(relPath, "/")
	for _, part := range parts {
		if node.Files == nil {
			return asarResolvedEntry{}, nil, fmt.Errorf("missing_asar_entry:%s", relPath)
		}
		child, ok := node.Files[part]
		if !ok {
			return asarResolvedEntry{}, nil, fmt.Errorf("missing_asar_entry:%s", relPath)
		}
		node = child
	}
	if node.Offset == "" || node.Size <= 0 {
		return asarResolvedEntry{}, nil, fmt.Errorf("invalid_asar_entry:%s", relPath)
	}
	relOff, err := strconv.ParseInt(node.Offset, 10, 64)
	if err != nil {
		return asarResolvedEntry{}, nil, err
	}
	absOff := metadata.DataOffset + relOff
	f, err := os.Open(asarPath)
	if err != nil {
		return asarResolvedEntry{}, nil, err
	}
	defer f.Close()
	buf := make([]byte, node.Size)
	if _, err := f.ReadAt(buf, absOff); err != nil {
		return asarResolvedEntry{}, nil, err
	}
	hash := sha256Hex(buf)
	if node.Integrity != nil && node.Integrity.Hash != "" && node.Integrity.Hash != hash {
		return asarResolvedEntry{}, nil, fmt.Errorf("asar_entry_integrity_mismatch:%s", relPath)
	}
	return asarResolvedEntry{
		Path:           relPath,
		Size:           node.Size,
		AbsoluteOffset: absOff,
		IntegrityHash:  hash,
	}, buf, nil
}

func verifyZcodeShadowBundle(shadowAsar, shadowHook, shadowExec string, source zcodeSourceInspection) bool {
	if _, err := os.Stat(shadowExec); err != nil {
		return false
	}
	hookBytes, err := os.ReadFile(shadowHook)
	if err != nil || sha256Hex(hookBytes) != source.hookHash {
		return false
	}
	meta, err := readAsarMetadata(shadowAsar)
	if err != nil || meta.HeaderHash != source.metadata.HeaderHash {
		return false
	}
	_, pkgRaw, err := readAndVerifyAsarEntry(shadowAsar, meta, "package.json")
	if err != nil {
		return false
	}
	var pkg map[string]any
	if json.Unmarshal(pkgRaw, &pkg) != nil || pkg["main"] != zcodeBootstrapEntryPath {
		return false
	}
	_, bootRaw, err := readAndVerifyAsarEntry(shadowAsar, meta, zcodeBootstrapEntryPath)
	if err != nil || !strings.HasPrefix(string(bootRaw), source.bootstrapSource) {
		return false
	}
	return true
}

func patchZcodeShadowAsar(shadowAsar string, source zcodeSourceInspection) error {
	meta, err := readAsarMetadata(shadowAsar)
	if err != nil || meta.HeaderHash != source.metadata.HeaderHash {
		return errors.New("shadow_asar_header_changed")
	}
	pkgEntry, _, err := readAndVerifyAsarEntry(shadowAsar, meta, "package.json")
	if err != nil {
		return err
	}
	bootEntry, _, err := readAndVerifyAsarEntry(shadowAsar, meta, zcodeBootstrapEntryPath)
	if err != nil {
		return err
	}
	patchedPkgMap := make(map[string]any, len(source.packageJSON))
	for k, v := range source.packageJSON {
		patchedPkgMap[k] = v
	}
	patchedPkgMap["main"] = zcodeBootstrapEntryPath
	patchedPkgBytes, err := json.Marshal(patchedPkgMap)
	if err != nil {
		return err
	}
	paddedPkg, err := padAsarEntry(patchedPkgBytes, pkgEntry.Size)
	if err != nil {
		return err
	}
	paddedBoot, err := padAsarEntry([]byte(source.bootstrapSource), bootEntry.Size)
	if err != nil {
		return err
	}

	f, err := os.OpenFile(shadowAsar, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.WriteAt(paddedPkg, pkgEntry.AbsoluteOffset); err != nil {
		return err
	}
	if _, err := f.WriteAt(paddedBoot, bootEntry.AbsoluteOffset); err != nil {
		return err
	}
	// 如 agent entry 仍包含未打补丁的 cwd 模式，仅当替换长度 <= 原长度时原地补丁。
	_, agentRaw, agentErr := readAndVerifyAsarEntry(shadowAsar, meta, source.agentEntryPath)
	if agentErr == nil && len(source.agentCwdMatch) >= len(zcodeAgentRuntimeReplacement) {
		if loc := zcodeAgentCwdFieldPattern.FindIndex(agentRaw); loc != nil {
			patchedAgent := make([]byte, len(agentRaw))
			copy(patchedAgent, agentRaw)
			paddedRepl, padErr := padAsarEntry([]byte(zcodeAgentRuntimeReplacement), int64(loc[1]-loc[0]))
			if padErr == nil {
				copy(patchedAgent[loc[0]:loc[1]], paddedRepl)
				_, _ = f.WriteAt(patchedAgent, source.agentEntry.AbsoluteOffset)
			}
		}
	}
	return f.Sync()
}

func padAsarEntry(content []byte, size int64) ([]byte, error) {
	if int64(len(content)) > size {
		return nil, errors.New("asar_patch_entry_too_small")
	}
	out := make([]byte, size)
	for i := range out {
		out[i] = ' '
	}
	copy(out, content)
	if int64(len(out)) > int64(len(content)) {
		out[len(out)-1] = '\n'
	}
	return out, nil
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func jsonContainsString(value any, target string) bool {
	switch typed := value.(type) {
	case string:
		return typed == target
	case []any:
		for _, item := range typed {
			if jsonContainsString(item, target) {
				return true
			}
		}
	case map[string]any:
		for _, item := range typed {
			if jsonContainsString(item, target) {
				return true
			}
		}
	}
	return false
}

// repairZcodeProjectionLinks 清理旧版在 <profileDir>/.zcode 下留下的悬空符号链接，
// 防止 ZCode backup 目录 mkdir 因 dangling symlink 报 ENOENT 而启动失败。
func repairZcodeProjectionLinks(profileDir string) {
	zcodeRoot := filepath.Join(strings.TrimSpace(profileDir), ".zcode")
	entries, err := os.ReadDir(zcodeRoot)
	if err != nil {
		return
	}
	for _, entry := range entries {
		full := filepath.Join(zcodeRoot, entry.Name())
		info, lerr := os.Lstat(full)
		if lerr != nil || info.Mode()&os.ModeSymlink == 0 {
			continue
		}
		if _, serr := os.Stat(full); os.IsNotExist(serr) {
			_ = os.Remove(full)
		}
	}
}

// repairZcodeProjectionCredentialProfile 就地把旧格式 user_info 归一化为 ZCode 桌面端认可的结构。
func repairZcodeProjectionCredentialProfile(profileDir string, hostHomeDir string, environ []string) {
	credPath := filepath.Join(strings.TrimSpace(profileDir), ".zcode", "v2", "credentials.json")
	raw, err := os.ReadFile(credPath)
	if err != nil {
		return
	}
	var creds map[string]any
	if err := json.Unmarshal(raw, &creds); err != nil || creds == nil {
		return
	}
	secret := resolveZcodeSecretForHost(hostHomeDir, environ)
	changed := false
	for key, stored := range creds {
		match := zcodeUserInfoKeyPattern.FindStringSubmatch(key)
		if len(match) < 2 {
			continue
		}
		region := match[1]
		strVal, ok := stored.(string)
		if !ok || strings.TrimSpace(strVal) == "" {
			continue
		}
		encrypted := zcodecred.IsEncrypted(strVal)
		plain := strVal
		if encrypted {
			dec, decOK := zcodecred.DecryptValue(strVal, secret)
			if !decOK {
				continue
			}
			plain = dec
		}
		var userMap map[string]any
		if json.Unmarshal([]byte(plain), &userMap) != nil || userMap == nil {
			continue
		}
		if hasZcodeDesktopProfileShape(userMap) {
			continue
		}
		norm := normalizeZcodeUserProfileMap(userMap, region)
		if norm == nil {
			continue
		}
		encoded, err := json.Marshal(norm)
		if err != nil {
			continue
		}
		if encrypted {
			enc, encErr := zcodecred.EncryptValue(string(encoded), secret)
			if encErr != nil {
				continue
			}
			creds[key] = enc
		} else {
			creds[key] = string(encoded)
		}
		changed = true
	}
	if changed {
		_ = writeJSONAtomic(credPath, creds)
	}
}

func hasZcodeDesktopProfileShape(user map[string]any) bool {
	if user == nil {
		return false
	}
	for _, field := range []string{"id", "username", "displayName"} {
		if _, ok := user[field].(string); !ok {
			return false
		}
	}
	return true
}

func normalizeZcodeUserProfileMap(user map[string]any, region string) map[string]any {
	if user == nil {
		return nil
	}
	id := stringField(user, "customerNumber", "user_id", "userId", "id", "sub")
	name := stringField(user, "customerName", "nickName", "name", "username", "display_name")
	email := stringField(user, "email")
	label := firstNonEmptyString(name, email, id)
	if id == "" || label == "" {
		return nil
	}
	avatar := stringField(user, "avatar", "avatarUrl", "avatar_url", "picture")
	rawProfile := make(map[string]any, len(user)+1)
	for k, v := range user {
		rawProfile[k] = v
	}
	if strings.EqualFold(region, "bigmodel") {
		rawProfile["zcodeProfileSchemaVersion"] = 2
	}
	out := map[string]any{
		"id":          id,
		"username":    label,
		"displayName": label,
		"rawProfile":  rawProfile,
	}
	if avatar != "" {
		out["avatarUrl"] = avatar
	}
	return out
}

func encodeZcodeContext(fields map[string]string) string {
	order := []string{"scope", "captchaState", "usageLog", "bridgeDir", "bridgeIdentity", "thinkingModels", "requestLog", "harnessStore"}
	parts := make([]string, 0, len(order))
	for _, key := range order {
		val := strings.TrimSpace(fields[key])
		if val == "" {
			continue
		}
		escaped := strings.ReplaceAll(url.QueryEscape(val), "+", "%20")
		parts = append(parts, key+"="+escaped)
	}
	return strings.Join(parts, ",")
}

func ensureZcodeAgentLauncher(profileDir, nodeExecutable, repoRoot, bundlePath string) (string, bool) {
	if strings.TrimSpace(repoRoot) == "" || strings.TrimSpace(bundlePath) == "" || strings.TrimSpace(nodeExecutable) == "" {
		return "", false
	}
	runnerPath := filepath.Join(repoRoot, "lib", "runtime", "zcode-session-attribution-runner.js")
	entryPath := filepath.Join(bundlePath, "Contents", "Resources", "glm", "zcode.cjs")
	if !pathExists(runnerPath) || !pathExists(entryPath) {
		return "", false
	}
	launcherPath := filepath.Join(profileDir, ".aih-runtime", zcodeAgentLauncherRelPath)
	nodeJSON, _ := json.Marshal(strings.TrimSpace(nodeExecutable))
	runnerJSON, _ := json.Marshal(runnerPath)
	entryJSON, _ := json.Marshal(entryPath)
	src := fmt.Sprintf(`#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');

const nodeExecutable = %s;
const runnerPath = %s;
const entryPath = %s;
if (!nodeExecutable || !runnerPath || !entryPath) {
  throw new Error('aih_zcode_agent_launcher_paths_missing');
}

const args = [runnerPath, entryPath, ...process.argv.slice(2)];
if (typeof process.stdin.fd === 'number') {
  const result = spawnSync(nodeExecutable, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  process.exitCode = typeof result.status === 'number' ? result.status : 1;
} else {
  const child = spawn(nodeExecutable, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
  });
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once('error', (error) => {
    process.stderr.write(String(error.stack || error.message || error) + '\n');
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode = typeof code === 'number' ? code : 1;
  });
}
`, nodeJSON, runnerJSON, entryJSON)
	existing, err := os.ReadFile(launcherPath)
	if err != nil || string(existing) != src {
		_ = writeBytesAtomic(launcherPath, []byte(src), 0o700)
	}
	_ = os.Chmod(launcherPath, 0o700)
	return launcherPath, true
}

func resolveZcodeRequestCaptureLogPath(aiHomeDir string) string {
	if strings.TrimSpace(aiHomeDir) == "" {
		return ""
	}
	markerPath := filepath.Join(aiHomeDir, "run", "zcode-request-capture.json")
	raw, err := os.ReadFile(markerPath)
	if err != nil {
		return ""
	}
	var cfg map[string]any
	if json.Unmarshal(raw, &cfg) == nil && cfg != nil {
		if p := stringField(cfg, "logPath"); p != "" {
			return p
		}
	}
	return filepath.Join(aiHomeDir, "run", "zcode-requests.jsonl")
}

func resolveZcodeBridgeDirs(profileDir string, snapshot AccountSnapshot) (mailboxDir string, identity string) {
	if len(snapshot.NativeAuthJSON) == 0 || snapshot.APIKeyMode {
		return "", ""
	}
	var root map[string]any
	if json.Unmarshal(snapshot.NativeAuthJSON, &root) != nil || root == nil {
		return "", ""
	}
	creds, _ := root["credentials"].(map[string]any)
	if creds == nil {
		return "", ""
	}
	// 提取稳定身份指纹（user_info.user_id/userId/id），用于桥目录隔离与识别。
	var userID string
	for _, key := range []string{"oauth:zai:user_info", "oauth:bigmodel:user_info"} {
		rawVal, _ := creds[key].(string)
		if strings.TrimSpace(rawVal) == "" {
			continue
		}
		var u map[string]any
		if json.Unmarshal([]byte(rawVal), &u) == nil && u != nil {
			userID = stringField(u, "user_id", "userId", "id")
			if userID != "" {
				break
			}
		}
	}
	if userID == "" {
		return "", ""
	}
	h := sha256.Sum256([]byte("zcode-desktop:" + strings.ToLower(strings.TrimSpace(userID))))
	identity = hex.EncodeToString(h[:])

	runtimeDir := filepath.Join(profileDir, ".aih-runtime")
	if real, err := filepath.EvalSymlinks(runtimeDir); err == nil && strings.TrimSpace(real) != "" {
		runtimeDir = real
	}
	mailboxDir = filepath.Join(runtimeDir, "zcode-desktop-bridge")
	for _, sub := range []string{"", "hosts", "requests", "results", "cancellations"} {
		if mkErr := os.MkdirAll(filepath.Join(mailboxDir, sub), 0o700); mkErr != nil {
			return "", ""
		}
	}
	return mailboxDir, identity
}
