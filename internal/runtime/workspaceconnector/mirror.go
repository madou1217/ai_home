package workspaceconnector

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/remoteconnector"
)

const (
	defaultMirrorMaxFiles      = 5000
	defaultMirrorMaxTotalBytes = int64(256 << 20)
	defaultMirrorMaxFileBytes  = int64(4 << 20)
	defaultMirrorMaxDepth      = 32
	mirrorManifestName         = "manifest.json"
	mirrorManifestVersion      = 1
)

// MirrorOptions bounds one materialization. A mirror is intentionally a
// best-effort source checkout, not a backup: dependency and build directories
// are skipped and oversized trees fail loudly instead of silently truncating.
type MirrorOptions struct {
	MaxFiles      int
	MaxTotalBytes int64
	MaxFileBytes  int64
	MaxDepth      int
}

func (options MirrorOptions) normalized() MirrorOptions {
	if options.MaxFiles <= 0 {
		options.MaxFiles = defaultMirrorMaxFiles
	}
	if options.MaxTotalBytes <= 0 {
		options.MaxTotalBytes = defaultMirrorMaxTotalBytes
	}
	if options.MaxFileBytes <= 0 {
		options.MaxFileBytes = defaultMirrorMaxFileBytes
	}
	if options.MaxDepth <= 0 {
		options.MaxDepth = defaultMirrorMaxDepth
	}
	return options
}

// Mirror is the identity and materialization summary of one connector mirror.
type Mirror struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspaceId"`
	Root        string   `json:"root"`
	Path        string   `json:"path"`
	Files       int      `json:"files"`
	Bytes       int64    `json:"bytes"`
	Skipped     []string `json:"skipped,omitempty"`
	CreatedAt   int64    `json:"createdAt"`
}

// MirrorSyncResult reports what was actually written back to the connector.
type MirrorSyncResult struct {
	Written   int      `json:"written"`
	Deleted   int      `json:"deleted"`
	Unchanged int      `json:"unchanged"`
	Conflicts int      `json:"conflicts"`
	Errors    int      `json:"errors"`
	Skipped   int      `json:"skipped"`
	Messages  []string `json:"messages,omitempty"`
}

type mirrorManifest struct {
	Version     int                            `json:"version"`
	WorkspaceID string                         `json:"workspaceId"`
	CreatedAt   int64                          `json:"createdAt"`
	Files       map[string]mirrorManifestEntry `json:"files"`
}

type mirrorManifestEntry struct {
	Version string `json:"version"`
	Hash    string `json:"hash"`
	Size    int64  `json:"size"`
}

var mirrorSyncLocks sync.Map

// StartMirror pulls the connector workspace into a Server-local directory. It
// requires an online connector: an offline pull would materialize an empty
// tree and let an agent "succeed" without touching the user's project.
func StartMirror(ctx context.Context, hub *Hub, workspaceID, aiHomeDir string, options MirrorOptions) (Mirror, error) {
	if hub == nil {
		return Mirror{}, fmt.Errorf("%s: workspace connector hub is unavailable", remoteconnector.CodeWorkspaceOffline)
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if _, err := ShadowDir(aiHomeDir, workspaceID); err != nil {
		return Mirror{}, err
	}
	if !hub.Online(workspaceID) {
		return Mirror{}, fmt.Errorf("%s: workspace connector is offline", remoteconnector.CodeWorkspaceOffline)
	}
	options = options.normalized()
	mirrorID, err := newMirrorID()
	if err != nil {
		return Mirror{}, err
	}
	root, err := MirrorRoot(aiHomeDir, workspaceID, mirrorID)
	if err != nil {
		return Mirror{}, err
	}
	workspaceDir := filepath.Join(root, "workspace")
	if err := os.MkdirAll(workspaceDir, 0o700); err != nil {
		return Mirror{}, err
	}
	manifest := mirrorManifest{
		Version:     mirrorManifestVersion,
		WorkspaceID: workspaceID,
		CreatedAt:   time.Now().UnixMilli(),
		Files:       map[string]mirrorManifestEntry{},
	}
	state := &mirrorPullState{manifest: &manifest, options: options}
	if err := pullMirrorTree(ctx, hub, workspaceID, "", workspaceDir, 0, state); err != nil {
		_ = os.RemoveAll(root)
		return Mirror{}, err
	}
	if err := writeMirrorManifest(root, manifest); err != nil {
		_ = os.RemoveAll(root)
		return Mirror{}, err
	}
	return Mirror{
		ID:          mirrorID,
		WorkspaceID: workspaceID,
		Root:        root,
		Path:        workspaceDir,
		Files:       len(manifest.Files),
		Bytes:       state.bytes,
		Skipped:     state.skipped,
		CreatedAt:   manifest.CreatedAt,
	}, nil
}

type mirrorPullState struct {
	manifest *mirrorManifest
	options  MirrorOptions
	bytes    int64
	skipped  []string
}

func pullMirrorTree(
	ctx context.Context,
	hub *Hub,
	workspaceID, rel, destination string,
	depth int,
	state *mirrorPullState,
) error {
	if depth > state.options.MaxDepth {
		return fmt.Errorf("workspace mirror depth exceeds %d at %s", state.options.MaxDepth, rel)
	}
	raw, err := hub.Call(ctx, workspaceID, remoteconnector.OperationListDirectory, remoteconnector.ListDirectoryRequest{
		Path: rel, Limit: 1000,
	})
	if err != nil {
		return err
	}
	var listing remoteconnector.ListDirectoryResult
	if err := json.Unmarshal(raw, &listing); err != nil {
		return fmt.Errorf("%s: invalid directory result", remoteconnector.CodeProtocolError)
	}
	if listing.Truncated {
		return fmt.Errorf("workspace directory is too large at %s", rel)
	}
	entries := append([]remoteconnector.DirectoryEntry(nil), listing.Entries...)
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	for _, entry := range entries {
		name := strings.TrimSpace(entry.Name)
		if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
			continue
		}
		childRel := name
		if rel != "" {
			childRel = path.Join(rel, name)
		}
		if mirrorIgnored(childRel) {
			state.skipped = append(state.skipped, childRel)
			continue
		}
		switch strings.ToLower(strings.TrimSpace(entry.Type)) {
		case "dir":
			childDestination := filepath.Join(destination, filepath.FromSlash(name))
			if err := os.MkdirAll(childDestination, 0o700); err != nil {
				return err
			}
			if err := pullMirrorTree(ctx, hub, workspaceID, childRel, childDestination, depth+1, state); err != nil {
				return err
			}
		case "file":
			if entry.Size > state.options.MaxFileBytes {
				state.skipped = append(state.skipped, childRel)
				continue
			}
			content, version, err := readConnectorFile(ctx, hub, workspaceID, childRel, state.options.MaxFileBytes)
			if err != nil {
				return err
			}
			if content == nil {
				state.skipped = append(state.skipped, childRel)
				continue
			}
			if len(state.manifest.Files) >= state.options.MaxFiles {
				return fmt.Errorf("workspace mirror exceeds %d files", state.options.MaxFiles)
			}
			if state.bytes+int64(len(content)) > state.options.MaxTotalBytes {
				return fmt.Errorf("workspace mirror exceeds %d bytes", state.options.MaxTotalBytes)
			}
			fileDestination := filepath.Join(destination, filepath.FromSlash(name))
			if err := os.MkdirAll(filepath.Dir(fileDestination), 0o700); err != nil {
				return err
			}
			if err := os.WriteFile(fileDestination, content, 0o600); err != nil {
				return err
			}
			state.bytes += int64(len(content))
			state.manifest.Files[childRel] = mirrorManifestEntry{
				Version: version, Hash: hashBytes(content), Size: int64(len(content)),
			}
		default:
			state.skipped = append(state.skipped, childRel)
		}
	}
	return nil
}

// SyncMirror writes changed, added and deleted files back to the connector. A
// remote version change is reported as a conflict and never overwritten.
func SyncMirror(ctx context.Context, hub *Hub, workspaceID, aiHomeDir, mirrorID string, options MirrorOptions) (MirrorSyncResult, error) {
	result := MirrorSyncResult{}
	if hub == nil {
		return result, fmt.Errorf("%s: workspace connector hub is unavailable", remoteconnector.CodeWorkspaceOffline)
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if !hub.Online(workspaceID) {
		return result, fmt.Errorf("%s: workspace connector is offline", remoteconnector.CodeWorkspaceOffline)
	}
	options = options.normalized()
	root, err := MirrorRoot(aiHomeDir, workspaceID, mirrorID)
	if err != nil {
		return result, err
	}
	lockValue, _ := mirrorSyncLocks.LoadOrStore(root, &sync.Mutex{})
	lock := lockValue.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()

	manifest, err := readMirrorManifest(root)
	if err != nil {
		return result, err
	}
	if manifest.WorkspaceID != workspaceID {
		return result, fmt.Errorf("%s: mirror belongs to another workspace", remoteconnector.CodeInvalidPayload)
	}
	workspaceDir := filepath.Join(root, "workspace")
	present := map[string]bool{}
	collected := make([]string, 0)
	walkErr := filepath.WalkDir(workspaceDir, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if current == workspaceDir {
			return nil
		}
		rel, relErr := filepath.Rel(workspaceDir, current)
		if relErr != nil {
			return relErr
		}
		rel = filepath.ToSlash(rel)
		if mirrorIgnored(rel) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			result.Skipped++
			result.Messages = append(result.Messages, "跳过符号链接 "+rel)
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		present[rel] = true
		collected = append(collected, rel)
		return nil
	})
	if walkErr != nil {
		return result, walkErr
	}
	sort.Strings(collected)
	runCommand := connectorRunCommandCapability(hub, workspaceID)
	ensuredDirs := map[string]bool{}
	for _, rel := range collected {
		full := filepath.Join(workspaceDir, filepath.FromSlash(rel))
		info, statErr := os.Stat(full)
		if statErr != nil {
			result.Errors++
			result.Messages = append(result.Messages, "读取镜像文件失败 "+rel+": "+statErr.Error())
			continue
		}
		if info.Size() > options.MaxFileBytes {
			result.Skipped++
			result.Messages = append(result.Messages, "跳过超大文件 "+rel)
			continue
		}
		content, readErr := os.ReadFile(full)
		if readErr != nil {
			result.Errors++
			result.Messages = append(result.Messages, "读取镜像文件失败 "+rel+": "+readErr.Error())
			continue
		}
		hash := hashBytes(content)
		baseline, existed := manifest.Files[rel]
		if existed && baseline.Hash == hash {
			result.Unchanged++
			continue
		}
		if !existed {
			parent := path.Dir(rel)
			if parent != "." && parent != "/" && !ensuredDirs[parent] {
				if !runCommand {
					result.Errors++
					result.Messages = append(result.Messages, "Connector 未开放 run_command，无法创建目录 "+parent)
					continue
				}
				if err := ensureConnectorDirectory(ctx, hub, workspaceID, parent); err != nil {
					result.Errors++
					result.Messages = append(result.Messages, "创建远程目录失败 "+parent+": "+err.Error())
					continue
				}
				ensuredDirs[parent] = true
			}
		}
		expected := ""
		if existed {
			expected = baseline.Version
		}
		version, writeErr := writeConnectorFile(ctx, hub, workspaceID, rel, content, expected)
		if writeErr != nil {
			if remoteconnector.ErrorCode(writeErr) == remoteconnector.CodeVersionConflict {
				result.Conflicts++
				result.Messages = append(result.Messages, "本地已有新修改，未覆盖 "+rel)
				continue
			}
			result.Errors++
			result.Messages = append(result.Messages, "写回失败 "+rel+": "+writeErr.Error())
			continue
		}
		manifest.Files[rel] = mirrorManifestEntry{Version: version, Hash: hash, Size: int64(len(content))}
		result.Written++
	}

	deleted := make([]string, 0)
	for rel := range manifest.Files {
		if !present[rel] {
			deleted = append(deleted, rel)
		}
	}
	sort.Strings(deleted)
	for _, rel := range deleted {
		if !runCommand {
			result.Skipped++
			result.Messages = append(result.Messages, "Connector 未开放 run_command，无法删除 "+rel)
			continue
		}
		baseline := manifest.Files[rel]
		currentContent, currentVersion, readErr := readConnectorFile(ctx, hub, workspaceID, rel, options.MaxFileBytes)
		if readErr != nil {
			if remoteconnector.ErrorCode(readErr) == remoteconnector.CodePathNotFound {
				delete(manifest.Files, rel)
				result.Deleted++
				continue
			}
			result.Errors++
			result.Messages = append(result.Messages, "删除前读取失败 "+rel+": "+readErr.Error())
			continue
		}
		if currentContent != nil && currentVersion != baseline.Version {
			result.Conflicts++
			result.Messages = append(result.Messages, "本地已有新修改，未删除 "+rel)
			continue
		}
		command := "rm -f -- " + shellQuote(rel)
		raw, runErr := hub.Call(ctx, workspaceID, remoteconnector.OperationRunCommand, remoteconnector.RunCommandRequest{
			Command: command, TimeoutMS: 30000,
		})
		if runErr != nil {
			code := remoteconnector.ErrorCode(runErr)
			if code == remoteconnector.CodeApprovalRequired {
				result.Skipped++
				result.Messages = append(result.Messages, "删除需要本地审批 "+rel)
				continue
			}
			result.Errors++
			result.Messages = append(result.Messages, "删除失败 "+rel+": "+runErr.Error())
			continue
		}
		var commandResult remoteconnector.RunCommandResult
		_ = json.Unmarshal(raw, &commandResult)
		if commandResult.ExitCode != 0 {
			result.Errors++
			result.Messages = append(result.Messages, "删除失败 "+rel+": "+strings.TrimSpace(commandResult.Stderr))
			continue
		}
		delete(manifest.Files, rel)
		result.Deleted++
	}
	if err := writeMirrorManifest(root, *manifest); err != nil {
		return result, err
	}
	return result, nil
}

// RemoveMirror deletes one materialized mirror. It never follows a symlink and
// only touches the computed mirror root.
func RemoveMirror(aiHomeDir, workspaceID, mirrorID string) error {
	root, err := MirrorRoot(aiHomeDir, workspaceID, mirrorID)
	if err != nil {
		return err
	}
	return os.RemoveAll(root)
}

func connectorRunCommandCapability(hub *Hub, workspaceID string) bool {
	status, ok := hub.Status(workspaceID)
	if !ok {
		return false
	}
	return status.Capabilities.RunCommand
}

func readConnectorFile(ctx context.Context, hub *Hub, workspaceID, rel string, maxBytes int64) ([]byte, string, error) {
	raw, err := hub.Call(ctx, workspaceID, remoteconnector.OperationReadFile, remoteconnector.ReadFileRequest{
		Path: rel, MaxBytes: maxBytes + 1,
	})
	if err != nil {
		return nil, "", err
	}
	var result remoteconnector.ReadFileResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, "", fmt.Errorf("%s: invalid read result", remoteconnector.CodeProtocolError)
	}
	if result.Truncated {
		return nil, "", nil
	}
	content, err := base64.StdEncoding.DecodeString(result.Content)
	if err != nil {
		return nil, "", fmt.Errorf("%s: invalid file content", remoteconnector.CodeProtocolError)
	}
	return content, result.Version, nil
}

func writeConnectorFile(ctx context.Context, hub *Hub, workspaceID, rel string, content []byte, expectedVersion string) (string, error) {
	raw, err := hub.Call(ctx, workspaceID, remoteconnector.OperationWriteFile, remoteconnector.WriteFileRequest{
		Path: rel, Content: base64.StdEncoding.EncodeToString(content), Encoding: "base64",
		ExpectedVersion: expectedVersion,
	})
	if err != nil {
		return "", err
	}
	var result remoteconnector.WriteFileResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return "", fmt.Errorf("%s: invalid write result", remoteconnector.CodeProtocolError)
	}
	return result.Version, nil
}

func ensureConnectorDirectory(ctx context.Context, hub *Hub, workspaceID, rel string) error {
	raw, err := hub.Call(ctx, workspaceID, remoteconnector.OperationRunCommand, remoteconnector.RunCommandRequest{
		Command: "mkdir -p -- " + shellQuote(rel), TimeoutMS: 30000,
	})
	if err != nil {
		return err
	}
	var result remoteconnector.RunCommandResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return fmt.Errorf("%s: invalid command result", remoteconnector.CodeProtocolError)
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("mkdir exited %d: %s", result.ExitCode, strings.TrimSpace(result.Stderr))
	}
	return nil
}

func readMirrorManifest(root string) (*mirrorManifest, error) {
	raw, err := os.ReadFile(filepath.Join(root, mirrorManifestName))
	if err != nil {
		return nil, err
	}
	var manifest mirrorManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, err
	}
	if manifest.Version != mirrorManifestVersion || manifest.Files == nil {
		return nil, errors.New("mirror manifest is invalid")
	}
	return &manifest, nil
}

func writeMirrorManifest(root string, manifest mirrorManifest) error {
	raw, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	temp := filepath.Join(root, mirrorManifestName+".tmp")
	if err := os.WriteFile(temp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(temp, filepath.Join(root, mirrorManifestName))
}

func newMirrorID() (string, error) {
	var data [8]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(data[:]), nil
}

func hashBytes(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

var mirrorIgnoredSegments = map[string]bool{
	".git": true, ".hg": true, ".svn": true,
	"node_modules": true, "vendor": true,
	".venv": true, "venv": true, "__pycache__": true,
	".next": true, ".nuxt": true, ".turbo": true,
	"dist": true, "build": true, "target": true, "coverage": true,
	".cache": true, ".aih-mirror": true,
}

func mirrorIgnored(rel string) bool {
	parts := strings.Split(rel, "/")
	for _, part := range parts {
		if mirrorIgnoredSegments[part] {
			return true
		}
	}
	base := parts[len(parts)-1]
	return base == ".DS_Store" || strings.HasPrefix(base, ".aih-mirror")
}
