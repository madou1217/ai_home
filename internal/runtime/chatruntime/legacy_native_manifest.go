package chatruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// AdoptedNativeRunRequest is a value snapshot supplied by the canonical store,
// never reconstructed from a legacy manifest. IDs identify the one Done consumer.
type AdoptedNativeRunRequest struct {
	EngineRunID        string
	CanonicalSessionID string
	CanonicalTurnID    string
	CanonicalRunID     string
	Provider           string
	AccountRef         string
	Gateway            bool
	NativeSessionID    string
	ProjectPath        string
	RuntimeScope       string
}

var legacyNativeRunIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{6,80}$`)

func (r AdoptedNativeRunRequest) validate() error {
	if !legacyNativeRunIDPattern.MatchString(r.EngineRunID) {
		return fmt.Errorf("legacy_native_run_id_invalid")
	}
	for _, value := range []string{r.CanonicalSessionID, r.CanonicalTurnID, r.CanonicalRunID, r.NativeSessionID, r.Provider} {
		if value == "" || len(value) > 512 || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\x00\r\n\t") {
			return fmt.Errorf("legacy_native_canonical_identity_required")
		}
	}
	if r.Provider != strings.ToLower(r.Provider) || (r.Provider == "codex" && !r.Gateway) {
		return fmt.Errorf("legacy_native_provider_unsupported")
	}
	if (r.Gateway && (r.AccountRef != "" || !IsGatewayRuntimeScope(r.RuntimeScope))) ||
		(!r.Gateway && (!IsPublicAccountRef(r.AccountRef) || r.RuntimeScope != r.AccountRef)) {
		return fmt.Errorf("legacy_native_target_invalid")
	}
	if !filepath.IsAbs(r.ProjectPath) || filepath.Clean(r.ProjectPath) != r.ProjectPath || strings.ContainsAny(r.ProjectPath, "\x00\r\n\t") {
		return fmt.Errorf("legacy_native_project_identity_required")
	}
	return nil
}

// LegacyNativeRunRef contains addressing metadata already checked against the
// canonical caller. It confers no authority over a process or socket.
type LegacyNativeRunRef struct {
	Identity        AdoptedNativeRunRequest
	Multiplexer     string
	Socket          string
	TmuxSession     string
	LogPath         string
	InteractionMode string
}

type legacyNativeManifest struct {
	RunID           string `json:"runId"`
	Provider        string `json:"provider"`
	AccountRef      string `json:"accountRef"`
	Gateway         bool   `json:"gateway"`
	SessionID       string `json:"sessionId"`
	ProjectDirName  string `json:"projectDirName"`
	ProjectPath     string `json:"projectPath"`
	Model           string `json:"model"`
	InteractionMode string `json:"interactionMode"`
	Multiplexer     string `json:"multiplexer"`
	Socket          string `json:"socket"`
	TmuxSession     string `json:"tmuxSession"`
	LogPath         string `json:"logPath"`
	StartedAt       int64  `json:"startedAt"`
	UpdatedAt       int64  `json:"updatedAt"`
}

// Open only the caller-named file. Root confinement and before/after lstat checks
// reject symlinks, nonregular files, replacement and traversal; no directory scan.
func openLegacyNativeFile(aiHomeDir, relative string) (*os.File, error) {
	if !filepath.IsAbs(aiHomeDir) || filepath.Clean(aiHomeDir) != aiHomeDir || !filepath.IsLocal(relative) {
		return nil, fmt.Errorf("legacy_native_root_invalid")
	}
	rootInfo, err := os.Lstat(aiHomeDir)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("legacy_native_root_unavailable")
	}
	root, err := os.OpenRoot(aiHomeDir)
	if err != nil {
		return nil, fmt.Errorf("legacy_native_root_unavailable")
	}
	defer root.Close()
	openedRoot, err := root.Open(".")
	if err != nil {
		return nil, fmt.Errorf("legacy_native_root_unavailable")
	}
	openedRootInfo, statErr := openedRoot.Stat()
	closeErr := openedRoot.Close()
	if statErr != nil || closeErr != nil || !os.SameFile(rootInfo, openedRootInfo) {
		return nil, fmt.Errorf("legacy_native_root_replaced")
	}
	check := func() (os.FileInfo, error) {
		current := ""
		var info os.FileInfo
		for _, part := range strings.Split(relative, string(filepath.Separator)) {
			current = filepath.Join(current, part)
			info, err = root.Lstat(current)
			if err != nil || info.Mode()&os.ModeSymlink != 0 {
				return nil, fmt.Errorf("legacy_native_file_unavailable")
			}
			if current != relative && !info.IsDir() {
				return nil, fmt.Errorf("legacy_native_parent_invalid")
			}
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("legacy_native_file_not_regular")
		}
		return info, nil
	}
	before, err := check()
	if err != nil {
		return nil, err
	}
	file, err := root.Open(relative)
	if err != nil {
		return nil, fmt.Errorf("legacy_native_file_unavailable")
	}
	opened, statErr := file.Stat()
	after, checkErr := check()
	if statErr != nil || checkErr != nil || !os.SameFile(before, opened) || !os.SameFile(opened, after) {
		file.Close()
		return nil, fmt.Errorf("legacy_native_file_replaced")
	}
	return file, nil
}

func readLegacyNativeManifest(ctx context.Context, aiHomeDir string, request AdoptedNativeRunRequest) (LegacyNativeRunRef, error) {
	var ref LegacyNativeRunRef
	if err := ctx.Err(); err != nil {
		return ref, err
	}
	if err := request.validate(); err != nil {
		return ref, err
	}
	file, err := openLegacyNativeFile(aiHomeDir, filepath.Join("run", "webui-runs", request.EngineRunID+".json"))
	if err != nil {
		return ref, err
	}
	defer file.Close()
	const maxManifestBytes = 64 << 10
	data, err := io.ReadAll(io.LimitReader(file, maxManifestBytes+1))
	if err != nil || len(data) > maxManifestBytes {
		return ref, fmt.Errorf("legacy_native_manifest_read_failed")
	}
	var manifest legacyNativeManifest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return ref, fmt.Errorf("legacy_native_manifest_invalid")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return ref, fmt.Errorf("legacy_native_manifest_invalid")
	}
	expectedLog := filepath.Join(aiHomeDir, "logs", "webui-runs", request.EngineRunID+".log")
	if manifest.RunID != request.EngineRunID || manifest.Provider != request.Provider ||
		manifest.Gateway != request.Gateway || manifest.AccountRef != request.AccountRef ||
		manifest.SessionID != request.NativeSessionID || manifest.ProjectPath != request.ProjectPath ||
		manifest.LogPath != expectedLog {
		return ref, fmt.Errorf("legacy_native_identity_mismatch")
	}
	// Persisted backend is mandatory: no empty/default, herdr or platform fallback.
	if manifest.Multiplexer != "tmux" || manifest.TmuxSession != "run" || manifest.InteractionMode != "default" {
		return ref, fmt.Errorf("legacy_native_backend_unsupported")
	}
	compact := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, request.EngineRunID)
	if len(compact) > 12 {
		compact = compact[:12]
	}
	if compact == "" || manifest.Socket != "aih-run-"+compact {
		return ref, fmt.Errorf("legacy_native_socket_mismatch")
	}
	ref = LegacyNativeRunRef{Identity: request, Multiplexer: manifest.Multiplexer, Socket: manifest.Socket,
		TmuxSession: manifest.TmuxSession, LogPath: expectedLog, InteractionMode: manifest.InteractionMode}
	return ref, ctx.Err()
}
