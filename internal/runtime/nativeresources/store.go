package nativeresources

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const managedStoreKVKey = "native-resources.managed.v1"

// DomainError 描述原生资源管理领域错误，供 HTTP 层映射准确状态码。
type DomainError struct {
	Code   string `json:"error"`
	Detail any    `json:"detail,omitempty"`
}

func (e *DomainError) Error() string { return e.Code }

// HTTPStatus 返回与 Node 契约一致的 HTTP 错误状态码。
func (e *DomainError) HTTPStatus() int {
	if e.Code == "native_resource_payload_too_large" {
		return 413
	}
	if strings.Contains(e.Code, "required") ||
		strings.Contains(e.Code, "invalid") ||
		strings.Contains(e.Code, "forbidden") ||
		strings.Contains(e.Code, "missing") ||
		strings.Contains(e.Code, "unsupported") {
		return 400
	}
	return 409
}

// AsDomainError 判断并返回 *DomainError。
func AsDomainError(err error) (*DomainError, bool) {
	var de *DomainError
	if errors.As(err, &de) {
		return de, true
	}
	return nil, false
}

func fail(code string) error {
	return &DomainError{Code: code}
}

func requireCond(cond bool, code string) error {
	if !cond {
		return fail(code)
	}
	return nil
}

// MCPServerSpec 描述 MCP stdio 服务定义。
type MCPServerSpec struct {
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Cwd     string            `json:"cwd,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

// ManagedRecord 描述 app_kv 中持久化的托管资源记录（plugin / skill / mcp）。
type ManagedRecord struct {
	Kind          string         `json:"kind"`
	ID            string         `json:"id"`
	Provider      string         `json:"provider,omitempty"`
	Host          string         `json:"host,omitempty"`
	Scope         string         `json:"scope"`
	Target        string         `json:"target,omitempty"`
	Mode          string         `json:"mode,omitempty"`
	Version       string         `json:"version,omitempty"`
	Digest        string         `json:"digest,omitempty"`
	Enabled       bool           `json:"enabled"`
	Removed       bool           `json:"removed,omitempty"`
	CreatedAt     int64          `json:"createdAt"`
	UpdatedAt     int64          `json:"updatedAt"`
	Projections   []string       `json:"projections,omitempty"`
	Server        *MCPServerSpec `json:"server,omitempty"`
	ConfigFile    string         `json:"configFile,omitempty"`
	NativeInstall map[string]any `json:"nativeInstall,omitempty"`
	Projection    string         `json:"projection,omitempty"`
}

// ManagedState 是存入 app_kv native-resources.managed.v1 的顶层结构。
type ManagedState struct {
	SchemaVersion int             `json:"schemaVersion"`
	Revision      int             `json:"revision"`
	Resources     []ManagedRecord `json:"resources"`
}

func emptyManagedState() ManagedState {
	return ManagedState{SchemaVersion: 1, Revision: 0, Resources: []ManagedRecord{}}
}

type managedStore struct {
	aiHomeDir string
}

func newManagedStore(aiHomeDir string) (*managedStore, error) {
	trimmed := strings.TrimSpace(aiHomeDir)
	if trimmed == "" {
		return nil, fail("managed_resource_home_required")
	}
	return &managedStore{aiHomeDir: trimmed}, nil
}

func (s *managedStore) get(ctx context.Context) (ManagedState, error) {
	dbPath, err := appstate.DatabasePath(s.aiHomeDir)
	if err != nil {
		return emptyManagedState(), err
	}
	raw, found, err := appstate.ReadKV(ctx, dbPath, managedStoreKVKey)
	if err != nil {
		return emptyManagedState(), err
	}
	if !found || strings.TrimSpace(raw) == "" {
		return emptyManagedState(), nil
	}
	var st ManagedState
	if err := json.Unmarshal([]byte(raw), &st); err != nil {
		return emptyManagedState(), err
	}
	if st.SchemaVersion == 0 {
		st.SchemaVersion = 1
	}
	if st.Resources == nil {
		st.Resources = []ManagedRecord{}
	}
	return st, nil
}

func (s *managedStore) update(ctx context.Context, mutate func(state *ManagedState) (any, error)) (any, error) {
	dbPath, err := appstate.DatabasePath(s.aiHomeDir)
	if err != nil {
		return nil, err
	}
	var result any
	err = appstate.UpdateKV(ctx, dbPath, managedStoreKVKey, func(current string, found bool) (string, error) {
		st := emptyManagedState()
		if found && strings.TrimSpace(current) != "" {
			if decErr := json.Unmarshal([]byte(current), &st); decErr != nil {
				st = emptyManagedState()
			}
			if st.SchemaVersion == 0 {
				st.SchemaVersion = 1
			}
			if st.Resources == nil {
				st.Resources = []ManagedRecord{}
			}
		}
		prevBytes, _ := json.Marshal(st)
		res, mutErr := mutate(&st)
		if mutErr != nil {
			return "", mutErr
		}
		nextBytes, _ := json.Marshal(st)
		if !reflect.DeepEqual(prevBytes, nextBytes) {
			st.Revision++
			nextBytes, _ = json.Marshal(st)
		}
		result = res
		return string(nextBytes), nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// PackageFile 描述资源包内的单个规范化文件条目。
type PackageFile struct {
	Name       string
	Content    []byte
	Executable bool
}

func readTreeFiles(root string, errPrefix string) ([]PackageFile, error) {
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return nil, fail(errPrefix + "_missing")
	}
	if rootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, fail(errPrefix + "_symlink")
	}
	if !rootInfo.IsDir() {
		return nil, fail(errPrefix + "_type_invalid")
	}
	var files []PackageFile
	var totalBytes int64

	var walk func(dir, rel string) error
	walk = func(dir, rel string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return fail(errPrefix + "_missing")
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, entry := range entries {
			name := entry.Name()
			fullPath := filepath.Join(dir, name)
			relPath := name
			if rel != "" {
				relPath = rel + "/" + name
			}
			info, err := os.Lstat(fullPath)
			if err != nil {
				return fail(errPrefix + "_type_invalid")
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return fail(errPrefix + "_symlink")
			}
			if info.IsDir() {
				if err := walk(fullPath, relPath); err != nil {
					return err
				}
				continue
			}
			if !info.Mode().IsRegular() {
				return fail(errPrefix + "_type_invalid")
			}
			totalBytes += info.Size()
			if totalBytes > 4*1024*1024 || len(files) >= 256 {
				return fail(errPrefix + "_limit")
			}
			data, err := os.ReadFile(fullPath)
			if err != nil {
				return fail(errPrefix + "_read_failed")
			}
			files = append(files, PackageFile{
				Name:       relPath,
				Content:    data,
				Executable: info.Mode().Perm()&0o111 != 0,
			})
		}
		return nil
	}
	if err := walk(root, ""); err != nil {
		return nil, err
	}
	return files, nil
}

// digestFiles 计算与 Node skill-package.js 完全一致的包摘要（SHA-256）。
func digestFiles(files []PackageFile) string {
	h := sha256.New()
	for _, f := range files {
		header, _ := json.Marshal([]any{f.Name, len(f.Content), f.Executable})
		h.Write(header)
		h.Write(f.Content)
	}
	return hex.EncodeToString(h.Sum(nil))
}

func writePackageFiles(root string, files []PackageFile) error {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	for _, f := range files {
		target := filepath.Join(append([]string{root}, strings.Split(f.Name, "/")...)...)
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		perm := fs.FileMode(0o600)
		if f.Executable {
			perm = 0o700
		}
		if err := os.WriteFile(target, f.Content, perm); err != nil {
			return err
		}
	}
	return nil
}

func lstatMaybe(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	return info, nil
}

func atomicWriteFile(filePath string, data []byte, defaultPerm os.FileMode) error {
	info, err := lstatMaybe(filePath)
	if err != nil {
		return err
	}
	perm := defaultPerm
	if info != nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return fail("native_plugin_config_conflict")
		}
		perm = info.Mode().Perm()
	}
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", filePath, os.Getpid())
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	if err := os.Rename(tmp, filePath); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
