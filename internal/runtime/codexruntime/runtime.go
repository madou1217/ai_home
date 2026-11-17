// Package codexruntime owns AIH-managed, side-by-side official Codex installs.
// It does not own user configuration, accounts, legacy hooks or running sessions.
package codexruntime

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

const receiptName = "runtime.json"

var verifiedDigests sync.Map

type digestIdentity struct {
	path     string
	size     int64
	modified int64
	digest   string
}

var generationName = regexp.MustCompile(`^runtime-[0-9]+$`)

// Selection identifies a verified native executable in one immutable generation.
type Selection struct {
	Generation string `json:"generation"`
	Executable string `json:"executable"`
	Version    string `json:"version"`
	SHA256     string `json:"sha256"`
	Size       int64  `json:"size"`
}

type Receipt struct {
	Format      int        `json:"format"`
	Disabled    bool       `json:"disabled,omitempty"`
	Current     Selection  `json:"current"`
	Previous    *Selection `json:"previous,omitempty"`
	ActivatedAt time.Time  `json:"activatedAt"`
}

// Root is outside both AIH release runtimes and the user's original Codex install.
func Root(home string) string {
	if strings.TrimSpace(home) == "" {
		home = strings.TrimSpace(os.Getenv("AIH_HOST_HOME"))
	}
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	if runtime.GOOS == "windows" {
		return filepath.Join(home, "AppData", "Local", "aih-cli", "codex")
	}
	return filepath.Join(home, ".local", "share", "aih-cli", "codex")
}

// Current reads the last committed selection only. A damaged receipt is not
// permission to run a different PATH binary or download/replace anything.
func Current(home string) (string, *Receipt, error) {
	return current(Root(home))
}

func readReceipt(root string) (*Receipt, error) {
	if !filepath.IsAbs(root) {
		return nil, errors.New("Codex managed root must be absolute")
	}
	f, err := os.Open(filepath.Join(root, receiptName))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 32769))
	if err != nil || len(data) > 32768 {
		return nil, errors.New("Codex runtime receipt cannot be read")
	}
	var rec Receipt
	if err = json.Unmarshal(data, &rec); err != nil || rec.Format != 1 {
		return nil, errors.New("Codex runtime receipt is invalid")
	}
	return &rec, nil
}

func current(root string) (string, *Receipt, error) {
	receipt, err := readReceipt(root)
	if err != nil || receipt == nil {
		return "", nil, err
	}
	rec := *receipt
	if rec.Disabled {
		return "", &rec, nil
	}
	binary, err := selectionPath(root, rec.Current)
	if err != nil {
		return "", nil, err
	}
	return binary, &rec, nil
}

func selectionPath(root string, selected Selection) (string, error) {
	if !generationName.MatchString(selected.Generation) || !safeRelative(selected.Executable) ||
		selected.Version == "" || len(selected.SHA256) != 64 || selected.Size <= 0 {
		return "", errors.New("Codex runtime selection is invalid")
	}
	if _, err := hex.DecodeString(selected.SHA256); err != nil {
		return "", errors.New("Codex runtime digest is invalid")
	}
	releases, err := filepath.EvalSymlinks(filepath.Join(root, "releases"))
	if err != nil {
		return "", err
	}
	generation := filepath.Join(root, "releases", selected.Generation)
	resolvedGeneration, err := filepath.EvalSymlinks(generation)
	if err != nil {
		return "", err
	}
	relGeneration, err := filepath.Rel(releases, resolvedGeneration)
	if err != nil || relGeneration != selected.Generation {
		return "", errors.New("Codex generation escapes its managed releases")
	}
	binary, err := confinedExecutable(generation, selected.Executable)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(binary)
	if err != nil || info.Size() != selected.Size || !NativeExecutable(binary) {
		return "", errors.New("Codex runtime executable is missing or changed")
	}
	identity := digestIdentity{path: binary, size: info.Size(), modified: info.ModTime().UnixNano(), digest: selected.SHA256}
	if _, cached := verifiedDigests.Load(identity); !cached {
		f, openErr := os.Open(binary)
		if openErr != nil {
			return "", openErr
		}
		hash := sha256.New()
		_, hashErr := io.Copy(hash, f)
		_ = f.Close()
		if hashErr != nil {
			return "", hashErr
		}
		if hex.EncodeToString(hash.Sum(nil)) != selected.SHA256 {
			return "", errors.New("Codex runtime executable digest changed")
		}
		verifiedDigests.Store(identity, struct{}{})
	}
	return binary, nil
}

func safeRelative(value string) bool {
	return value != "" && value != "." && !filepath.IsAbs(value) && filepath.VolumeName(value) == "" &&
		filepath.Clean(value) == value && value != ".." && !strings.HasPrefix(value, ".."+string(filepath.Separator))
}

func confinedExecutable(root, relative string) (string, error) {
	if !safeRelative(relative) {
		return "", errors.New("invalid Codex runtime executable path")
	}
	base, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	actual, err := filepath.EvalSymlinks(filepath.Join(root, relative))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(base, actual)
	if err != nil || !safeRelative(rel) {
		return "", errors.New("Codex executable escapes its managed generation")
	}
	return actual, nil
}
