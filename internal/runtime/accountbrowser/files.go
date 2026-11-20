package accountbrowser

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func validateAIHomeDir(raw string) (string, error) {
	if raw == "" || strings.TrimSpace(raw) != raw || strings.ContainsRune(raw, 0) {
		return "", fmt.Errorf("aiHomeDir must be a clean non-empty absolute path: %w", ErrUnsafePath)
	}
	if !filepath.IsAbs(raw) {
		return "", fmt.Errorf("aiHomeDir must be absolute: %w", ErrUnsafePath)
	}
	if hasParentTraversal(raw) {
		return "", fmt.Errorf("aiHomeDir must not contain parent traversal: %w", ErrUnsafePath)
	}
	cleaned := filepath.Clean(raw)
	if cleaned == filepath.Dir(cleaned) {
		return "", fmt.Errorf("aiHomeDir must not be filesystem root: %w", ErrUnsafePath)
	}
	return cleaned, nil
}

func hasParentTraversal(path string) bool {
	for _, part := range strings.FieldsFunc(path, func(r rune) bool {
		return r == '/' || r == '\\'
	}) {
		if part == ".." {
			return true
		}
	}
	return false
}

func isPrivateMode(mode fs.FileMode) bool {
	if runtime.GOOS == "windows" {
		return true
	}
	return mode.Perm()&0o077 == 0
}

func openTrustedHomeRoot(aiHomeDir string, createMissing bool) (*os.Root, error) {
	info, err := os.Lstat(aiHomeDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			if !createMissing {
				return nil, ErrProfileNotFound
			}
			return nil, fmt.Errorf("aiHomeDir does not exist: %w", ErrUnsafePath)
		}
		return nil, fmt.Errorf("stat aiHomeDir: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, fmt.Errorf("aiHomeDir must be a real directory: %w", ErrUnsafePath)
	}
	root, err := os.OpenRoot(aiHomeDir)
	if err != nil {
		return nil, fmt.Errorf("open aiHomeDir root: %w", err)
	}
	openedInfo, err := root.Stat(".")
	if err != nil || !os.SameFile(info, openedInfo) {
		_ = root.Close()
		return nil, fmt.Errorf("aiHomeDir changed during open: %w", ErrUnsafePath)
	}
	return root, nil
}

func openVerifiedSubdir(parent *os.Root, name string, create bool, requirePrivate bool) (*os.Root, bool, error) {
	created := false
	if create {
		err := parent.Mkdir(name, privateDirPerm)
		if err == nil {
			created = true
		} else if !errors.Is(err, os.ErrExist) {
			return nil, false, fmt.Errorf("mkdir %s: %w", name, err)
		}
	}

	info, err := parent.Lstat(name)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, false, ErrProfileNotFound
		}
		return nil, false, fmt.Errorf("lstat %s: %w", name, err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return nil, false, fmt.Errorf("%s must be a real directory: %w", name, ErrUnsafePath)
	}
	if requirePrivate && !isPrivateMode(info.Mode()) {
		return nil, false, fmt.Errorf("%s must have private permissions: %w", name, ErrUnsafePath)
	}

	child, err := parent.OpenRoot(name)
	if err != nil {
		return nil, false, fmt.Errorf("open root %s: %w", name, err)
	}
	childInfo, err := child.Stat(".")
	if err != nil {
		_ = child.Close()
		return nil, false, fmt.Errorf("stat opened %s: %w", name, err)
	}
	if !os.SameFile(info, childInfo) {
		_ = child.Close()
		return nil, false, fmt.Errorf("%s changed during open: %w", name, ErrUnsafePath)
	}
	if requirePrivate && !isPrivateMode(childInfo.Mode()) {
		_ = child.Close()
		return nil, false, fmt.Errorf("%s must have private permissions: %w", name, ErrUnsafePath)
	}
	return child, created, nil
}

func (st *profileStore) tryReadExistingProfile(
	ctx context.Context,
	profileRoot *os.Root,
	identity Identity,
	profileID string,
) (Profile, fs.FileInfo, bool, error) {
	if err := ctx.Err(); err != nil {
		return Profile{}, nil, false, err
	}

	metaLstat, err := profileRoot.Lstat(metadataFileName)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// Check whether data/ already exists as an unsafe symlink/file even
			// while metadata is absent so tampered paths fail fast.
			if dataLstat, dErr := profileRoot.Lstat(dataDirName); dErr == nil {
				if dataLstat.Mode()&os.ModeSymlink != 0 || !dataLstat.IsDir() || !isPrivateMode(dataLstat.Mode()) {
					return Profile{}, nil, false, fmt.Errorf("profile data directory is unsafe: %w", ErrUnsafePath)
				}
			}
			return Profile{}, nil, true, ErrProfileCorrupt
		}
		return Profile{}, nil, false, fmt.Errorf("lstat profile metadata: %w", err)
	}
	if metaLstat.Mode()&os.ModeSymlink != 0 || !metaLstat.Mode().IsRegular() {
		return Profile{}, nil, false, fmt.Errorf("profile metadata must be a regular file: %w", ErrUnsafePath)
	}
	if !isPrivateMode(metaLstat.Mode()) {
		return Profile{}, nil, false, fmt.Errorf("profile metadata must have private permissions: %w", ErrUnsafePath)
	}
	if metaLstat.Size() > maxMetadataBytes {
		return Profile{}, nil, false, fmt.Errorf("profile metadata exceeds maximum size: %w", ErrProfileCorrupt)
	}

	metaFile, err := profileRoot.Open(metadataFileName)
	if err != nil {
		return Profile{}, nil, false, fmt.Errorf("open profile metadata: %w", err)
	}
	defer metaFile.Close()

	metaFstat, err := metaFile.Stat()
	if err != nil {
		return Profile{}, nil, false, fmt.Errorf("stat opened profile metadata: %w", err)
	}
	if !os.SameFile(metaLstat, metaFstat) || !metaFstat.Mode().IsRegular() || !isPrivateMode(metaFstat.Mode()) {
		return Profile{}, nil, false, fmt.Errorf("profile metadata changed or unsafe: %w", ErrUnsafePath)
	}

	raw, err := io.ReadAll(io.LimitReader(metaFile, maxMetadataBytes+1))
	if err != nil {
		return Profile{}, nil, false, fmt.Errorf("read profile metadata: %w", err)
	}
	if len(raw) > maxMetadataBytes {
		return Profile{}, nil, false, fmt.Errorf("profile metadata exceeds maximum size: %w", ErrProfileCorrupt)
	}

	profile, err := decodeAndValidateMetadata(raw, identity, profileID)
	if err != nil {
		return Profile{}, nil, false, err
	}

	dataInfo, err := verifyExistingPrivateDataDir(profileRoot)
	if err != nil {
		return Profile{}, nil, false, err
	}
	return profile, dataInfo, false, nil
}

func ensurePrivateDataDir(profileRoot *os.Root) (fs.FileInfo, error) {
	if err := profileRoot.Mkdir(dataDirName, privateDirPerm); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, fmt.Errorf("mkdir data dir: %w", err)
	}
	return verifyExistingPrivateDataDir(profileRoot)
}

func verifyExistingPrivateDataDir(profileRoot *os.Root) (fs.FileInfo, error) {
	lstatInfo, err := profileRoot.Lstat(dataDirName)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("profile data directory missing: %w", ErrProfileCorrupt)
		}
		return nil, fmt.Errorf("lstat data dir: %w", err)
	}
	if lstatInfo.Mode()&os.ModeSymlink != 0 || !lstatInfo.IsDir() {
		return nil, fmt.Errorf("profile data directory must be a real directory: %w", ErrUnsafePath)
	}
	if !isPrivateMode(lstatInfo.Mode()) {
		return nil, fmt.Errorf("profile data directory must have private permissions: %w", ErrUnsafePath)
	}
	dataRoot, err := profileRoot.OpenRoot(dataDirName)
	if err != nil {
		return nil, fmt.Errorf("open data dir: %w", err)
	}
	defer dataRoot.Close()

	openedInfo, err := dataRoot.Stat(".")
	if err != nil {
		return nil, fmt.Errorf("stat opened data dir: %w", err)
	}
	if !os.SameFile(lstatInfo, openedInfo) || !isPrivateMode(openedInfo.Mode()) {
		return nil, fmt.Errorf("profile data directory changed or unsafe: %w", ErrUnsafePath)
	}
	return openedInfo, nil
}

func (st *profileStore) verifiedAbsoluteDataDir(profileID string, pinnedDataInfo fs.FileInfo) (string, error) {
	if !isValidProfileID(profileID) {
		return "", fmt.Errorf("invalid derived profile id: %w", ErrUnsafePath)
	}
	dataDir := filepath.Join(st.aiHomeDir, runDirName, accountBrowserDirName, profilesDirName, profileID, dataDirName)
	if !filepath.IsAbs(dataDir) || hasParentTraversal(dataDir) {
		return "", fmt.Errorf("invalid data dir path: %w", ErrUnsafePath)
	}
	absInfo, err := os.Lstat(dataDir)
	if err != nil {
		return "", fmt.Errorf("verify absolute data dir: %w", ErrUnsafePath)
	}
	if absInfo.Mode()&os.ModeSymlink != 0 || !absInfo.IsDir() || !os.SameFile(pinnedDataInfo, absInfo) {
		return "", fmt.Errorf("absolute data dir mismatch: %w", ErrUnsafePath)
	}
	return dataDir, nil
}

func randomTempMetadataName() (string, error) {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", fmt.Errorf("generate temp metadata name: %w", err)
	}
	return ".profile-" + hex.EncodeToString(nonce[:]) + ".tmp", nil
}

func syncRootDir(root *os.Root) {
	dir, err := root.Open(".")
	if err != nil {
		return
	}
	_ = dir.Sync()
	_ = dir.Close()
}
