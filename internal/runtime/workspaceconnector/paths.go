package workspaceconnector

import (
	"errors"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	// ShadowRootDir is the Server-side anchor directory for connector workspaces.
	// The directory is not a copy of the local project; it is the stable project
	// path used by Work/requirements so a connector workspace has the same path
	// shape as other work workspaces.
	ShadowRootDir = "connector-workspaces"
	// MirrorRootDir holds on-demand mirrors used by agents that cannot operate
	// through the connector tool channel themselves.
	MirrorRootDir = "connector-mirrors"
)

var mirrorIDPattern = regexp.MustCompile(`^[a-f0-9]{16}$`)

var (
	// ErrInvalidWorkspaceID means the workspace identity is not a single path
	// segment. Connector IDs are opaque, so only path safety is enforced here.
	ErrInvalidWorkspaceID = errors.New("workspace connector id is invalid")
	// ErrInvalidMirrorID means the mirror identifier is malformed.
	ErrInvalidMirrorID = errors.New("workspace mirror id is invalid")
)

// ShadowDir returns the Server-side anchor directory for a connector workspace.
// It does not create the directory.
func ShadowDir(aiHomeDir, workspaceID string) (string, error) {
	root := strings.TrimSpace(aiHomeDir)
	id := strings.TrimSpace(workspaceID)
	if root == "" || id == "" || strings.ContainsAny(id, `/\`) || id == "." || id == ".." {
		return "", ErrInvalidWorkspaceID
	}
	return filepath.Join(root, "run", ShadowRootDir, id), nil
}

// WorkspaceIDFromShadowPath maps a Server-side anchor path back to its
// connector workspace id. It returns an empty string for every other path.
func WorkspaceIDFromShadowPath(aiHomeDir, projectPath string) string {
	root := strings.TrimSpace(aiHomeDir)
	target := strings.TrimSpace(projectPath)
	if root == "" || target == "" {
		return ""
	}
	prefix := filepath.Clean(filepath.Join(root, "run", ShadowRootDir)) + string(filepath.Separator)
	clean := strings.TrimRight(filepath.Clean(target), `/\`)
	if !strings.HasPrefix(clean, prefix) {
		return ""
	}
	rest := strings.TrimRight(strings.TrimPrefix(clean, prefix), `/\`)
	if rest == "" || strings.ContainsAny(rest, `/\`) || rest == "." || rest == ".." {
		return ""
	}
	return rest
}

// MirrorRoot returns the root directory for one mirror instance.
func MirrorRoot(aiHomeDir, workspaceID, mirrorID string) (string, error) {
	root := strings.TrimSpace(aiHomeDir)
	id := strings.TrimSpace(workspaceID)
	mirror := strings.TrimSpace(mirrorID)
	if root == "" || id == "" || strings.ContainsAny(id, `/\`) || id == "." || id == ".." {
		return "", ErrInvalidWorkspaceID
	}
	if !mirrorIDPattern.MatchString(mirror) {
		return "", ErrInvalidMirrorID
	}
	return filepath.Join(root, "run", MirrorRootDir, id, mirror), nil
}
