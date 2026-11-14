package desktopbuild

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func mkdirWithin(root, target string) error {
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return ErrInvalidOptions
	}
	current := root
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		if part == "." || part == "" {
			continue
		}
		current = filepath.Join(current, part)
		if err := os.Mkdir(current, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		info, err := os.Lstat(current)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("desktop_build_path_unsafe")
		}
		resolved, err := filepath.EvalSymlinks(current)
		if err != nil || !strings.EqualFold(filepath.Clean(resolved), filepath.Clean(current)) {
			return fmt.Errorf("desktop_build_path_unsafe")
		}
	}
	return nil
}

func acquireBuildLock(ctx context.Context, root string) (func(), error) {
	path := filepath.Join(root, ".go-build.lock")
	timer := time.NewTimer(4 * time.Minute)
	defer timer.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		err := os.Mkdir(path, 0o700)
		if err == nil {
			return func() { _ = os.Remove(path) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
			return nil, fmt.Errorf("desktop_build_lock_timeout")
		case <-ticker.C:
		}
	}
}

func hashBytes(parts ...[]byte) string {
	hash := sha256.New()
	for _, data := range parts {
		_, _ = hash.Write(data)
	}
	return hex.EncodeToString(hash.Sum(nil))
}

type artifactStamp struct {
	Source string            `json:"source"`
	Files  map[string]string `json:"files"`
}

func cachedArtifact(dir, source string, files ...string) bool {
	return cachedArtifactAt(dir, filepath.Join(dir, ".go-build.json"), source, files...)
}

func cachedArtifactAt(dir, stampPath, source string, files ...string) bool {
	raw, err := os.ReadFile(stampPath)
	if err != nil {
		return false
	}
	var stamp artifactStamp
	if json.Unmarshal(raw, &stamp) != nil || stamp.Source != source {
		return false
	}
	for _, relative := range files {
		path := filepath.Join(dir, relative)
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			return false
		}
		digest, err := hashFile(path)
		if err != nil || stamp.Files[relative] != digest {
			return false
		}
	}
	return true
}

func writeArtifactStamp(dir, source string, files ...string) error {
	return writeArtifactStampAt(dir, filepath.Join(dir, ".go-build.json"), source, files...)
}

func writeArtifactStampAt(dir, stampPath, source string, files ...string) error {
	stamp := artifactStamp{Source: source, Files: make(map[string]string, len(files))}
	for _, relative := range files {
		digest, err := hashFile(filepath.Join(dir, relative))
		if err != nil {
			return err
		}
		stamp.Files[relative] = digest
	}
	raw, err := json.Marshal(stamp)
	if err != nil {
		return err
	}
	return os.WriteFile(stampPath, raw, 0o600)
}

// publishDirectory is serialized by the home-scoped build lock. Build never writes
// through a cached executable: a running old image keeps its original inode/handle.
func publishDirectory(stage, target string) error {
	if info, err := os.Lstat(target); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("desktop_build_artifact_unsafe")
		}
		backup, err := os.MkdirTemp(filepath.Dir(target), ".old-build-")
		if err != nil {
			return err
		}
		if err := os.Remove(backup); err != nil {
			return err
		}
		if err := os.Rename(target, backup); err != nil {
			return err
		}
		if err := os.Rename(stage, target); err != nil {
			restoreErr := os.Rename(backup, target)
			return errors.Join(err, restoreErr)
		}
		return os.RemoveAll(backup)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Rename(stage, target)
}

func hashFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
