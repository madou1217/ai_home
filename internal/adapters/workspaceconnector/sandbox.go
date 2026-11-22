// Package workspaceconnector is the local side of the Workspace Connector
// protocol. It owns one explicitly selected root and never starts a model or a
// provider CLI.
package workspaceconnector

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/remoteconnector"
)

type sandbox struct {
	root string
}

func newSandbox(root string) (*sandbox, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPath, "workspace root is required")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPath, "workspace root is invalid")
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodePathNotFound, "workspace root does not exist")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPath, "workspace root must be a directory")
	}
	return &sandbox{root: resolved}, nil
}

// resolve confines a protocol-relative path to the root. It resolves every
// existing symlink component and rejects a target outside the root, so
// symlinks cannot widen the workspace.
func (s *sandbox) resolve(relative string, allowMissing bool) (string, error) {
	if s == nil || s.root == "" {
		return "", remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPath, "workspace root is unavailable")
	}
	relative = strings.TrimSpace(relative)
	if strings.ContainsRune(relative, 0) {
		return "", remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPath, "path contains a NUL byte")
	}
	native := filepath.FromSlash(relative)
	if filepath.IsAbs(native) || filepath.VolumeName(native) != "" {
		return "", remoteconnector.NewProtocolError(remoteconnector.CodePathOutsideWorkspace, "absolute paths are not allowed")
	}
	cleaned := filepath.Clean(native)
	if cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(os.PathSeparator)) {
		return "", remoteconnector.NewProtocolError(remoteconnector.CodePathOutsideWorkspace, "path escapes the workspace root")
	}
	target := s.root
	if cleaned != "." && cleaned != "" {
		target = filepath.Join(s.root, cleaned)
	}
	if !within(s.root, target) {
		return "", remoteconnector.NewProtocolError(remoteconnector.CodePathOutsideWorkspace, "path escapes the workspace root")
	}
	existing, missing := nearestExisting(target)
	resolved, err := filepath.EvalSymlinks(existing)
	if err != nil {
		if allowMissing && missing > 0 && errors.Is(err, os.ErrNotExist) {
			resolved = existing
		} else {
			return "", remoteconnector.NewProtocolError(remoteconnector.CodePathNotFound, "path does not exist")
		}
	}
	if missing > 0 {
		remainder, relErr := filepath.Rel(existing, target)
		if relErr != nil {
			return "", remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPath, "path cannot be resolved")
		}
		if remainder != "." && remainder != "" {
			resolved = filepath.Join(resolved, remainder)
		}
	}
	if !within(s.root, resolved) {
		return "", remoteconnector.NewProtocolError(remoteconnector.CodePathOutsideWorkspace, "path escapes the workspace root through a symlink")
	}
	if !allowMissing {
		if _, err := os.Lstat(resolved); err != nil {
			return "", remoteconnector.NewProtocolError(remoteconnector.CodePathNotFound, "path does not exist")
		}
	}
	return resolved, nil
}

func nearestExisting(target string) (string, int) {
	existing := target
	missing := 0
	for {
		if _, err := os.Lstat(existing); err == nil {
			return existing, missing
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			return existing, missing
		}
		existing = parent
		missing++
	}
}

func within(root, target string) bool {
	relative, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	if relative == "." {
		return true
	}
	return relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator))
}

func displayPath(root, target string) string {
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == "." {
		return "."
	}
	return filepath.ToSlash(relative)
}
