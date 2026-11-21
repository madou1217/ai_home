// Package codexpreferences owns safe reads and surgical updates of native Codex preferences.
package codexpreferences

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"

	codexconfig "github.com/madou1217/ai_home/internal/host/aihdefault/content/codex"
	"github.com/madou1217/ai_home/internal/runtime/providerconfigs"
)

// Snapshot contains only the non-secret preferences shown by the CLI.
type Snapshot struct {
	Path   string
	Model  string
	Effort string
	Tier   string
}

type document struct {
	content []byte
	info    os.FileInfo
}

// Read never creates a config file or directory.
func Read(home string) (Snapshot, error) {
	target, err := resolveTarget(home)
	if err != nil {
		return Snapshot{}, err
	}
	doc, err := readDocument(target)
	if err != nil {
		return Snapshot{}, err
	}
	return snapshot(target, doc.content), nil
}

// Update serializes AIH preference writers and detects intervening external edits.
// The native config's symlink, unrelated text and existing permission bits are preserved.
func Update(home, key, value string) (Snapshot, error) {
	return updateDocument(home, func(current string) (string, error) { return codexconfig.PatchPreference(current, key, value) })
}

// ReplaceDocument is the cooperating Node config-healer publication port. The
// original snapshot must still match after taking the shared Go advisory lock.
func ReplaceDocument(home, expected, next string) error {
	_, err := updateDocument(home, func(current string) (string, error) {
		if current != expected {
			return "", fmt.Errorf("codex_config_changed_retry")
		}
		return next, nil
	})
	return err
}

// UpdateDocument applies one pure, idempotent transform under the shared host
// lock and publishes the result atomically only when it differs. The existing
// config file, its symlink target and permission bits are preserved: this port
// never creates a host configuration. A transform that returns the input
// unchanged leaves the file and its metadata untouched.
func UpdateDocument(home string, transform func(current string) (string, error)) error {
	if transform == nil {
		return fmt.Errorf("codex_config_transform_missing")
	}
	target, err := resolveTarget(home)
	if err != nil {
		return err
	}
	info, err := os.Lstat(target)
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("Codex 配置不存在或不是普通文件，未修改")
	}
	_, err = updateDocument(home, transform)
	return err
}

func updateDocument(home string, transform func(string) (string, error)) (Snapshot, error) {
	target, release, err := AcquireHostLock(home)
	if err != nil {
		return Snapshot{}, err
	}
	defer release()
	if err := CheckHostReady(home); err != nil {
		return Snapshot{}, err
	}
	doc, err := readDocument(target)
	if err != nil {
		return Snapshot{}, err
	}
	patched, err := transform(string(doc.content))
	if err != nil {
		return Snapshot{}, err
	}
	if err := validate(patched); err != nil {
		return Snapshot{}, err
	}
	if patched == string(doc.content) {
		return snapshot(target, doc.content), nil
	}
	temp, err := os.CreateTemp(filepath.Dir(target), ".codex-preference-*")
	if err != nil {
		return Snapshot{}, err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(temp.Name())
		}
	}()
	defer temp.Close()
	mode := os.FileMode(0o600)
	if doc.info != nil {
		mode = doc.info.Mode().Perm()
	}
	if err := temp.Chmod(mode); err != nil {
		return Snapshot{}, err
	}
	if _, err := temp.WriteString(patched); err != nil {
		return Snapshot{}, err
	}
	if err := temp.Sync(); err != nil {
		return Snapshot{}, err
	}
	if err := temp.Close(); err != nil {
		return Snapshot{}, err
	}
	// Native Codex/editors need not take our advisory lock. Reject any change
	// observed before rename, including symlink retargets and file replacement.
	resolved, err := resolveTarget(home)
	if err != nil || resolved != target {
		return Snapshot{}, fmt.Errorf("Codex 配置路径已被其它进程修改，请重试")
	}
	latest, err := readDocument(target)
	if err != nil {
		return Snapshot{}, err
	}
	if !bytes.Equal(latest.content, doc.content) || !sameDocument(doc, latest) {
		return Snapshot{}, fmt.Errorf("Codex 配置已被其它进程修改，请重试")
	}
	if doc.info == nil {
		if err := publishNewConfig(temp.Name(), target); err != nil {
			return Snapshot{}, err
		}
	} else {
		preserve, err := replaceExistingConfig(temp.Name(), target, doc, []byte(patched))
		cleanup = !preserve
		if err != nil {
			return Snapshot{}, err
		}
	}
	return snapshot(target, []byte(patched)), nil
}

func resolveTarget(home string) (string, error) {
	target, err := filepath.Abs(filepath.Join(home, "config.toml"))
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(target); err == nil {
		return resolved, nil
	} else if info, statErr := os.Lstat(target); statErr == nil && info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("Codex 配置链接无法解析: %w", err)
	}
	// Canonicalize an existing parent even before the config is first created,
	// so aliased home paths acquire the same lock and compare equal after creation.
	if parent, err := filepath.EvalSymlinks(filepath.Dir(target)); err == nil {
		return filepath.Join(parent, filepath.Base(target)), nil
	}
	return target, nil
}

func readDocument(target string) (document, error) {
	file, err := os.Open(target)
	if os.IsNotExist(err) {
		return document{}, nil
	}
	if err != nil {
		return document{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return document{}, err
	}
	if !info.Mode().IsRegular() {
		return document{}, fmt.Errorf("Codex 配置不是普通文件")
	}
	// Read the same inode whose metadata we recorded, not a second pathname lookup.
	content, err := io.ReadAll(file)
	if err != nil {
		return document{}, err
	}
	if err := validate(string(content)); err != nil {
		return document{}, err
	}
	return document{content: content, info: info}, nil
}

func sameDocument(a, b document) bool {
	if a.info == nil || b.info == nil {
		return a.info == nil && b.info == nil
	}
	return os.SameFile(a.info, b.info) && a.info.Mode() == b.info.Mode()
}

func validate(content string) error {
	if result := providerconfigs.ValidateContent(content, "toml"); !result.Valid {
		return fmt.Errorf("Codex 配置无效，未修改: %v", result.Errors)
	}
	return nil
}

func snapshot(target string, content []byte) Snapshot {
	text := string(content)
	return Snapshot{
		Path:   target,
		Model:  codexconfig.RootString(text, "model"),
		Effort: codexconfig.RootString(text, "model_reasoning_effort"),
		Tier:   codexconfig.RootString(text, "service_tier"),
	}
}

// AcquireHostLock shares the preference writer's lock with host default changes.
// release must be called; this never modifies config content or removes lock inodes.
func AcquireHostLock(home string) (target string, release func(), err error) {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return "", nil, err
	}
	target, err = resolveTarget(home)
	if err != nil {
		return "", nil, err
	}
	lock, err := os.OpenFile(target+".aih-preferences.lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return "", nil, err
	}
	if err := lockExclusive(lock); err != nil {
		lock.Close()
		return "", nil, fmt.Errorf("Codex 配置正由其它进程修改，请重试")
	}
	return target, func() { unlockExclusive(lock); _ = lock.Close() }, nil
}
