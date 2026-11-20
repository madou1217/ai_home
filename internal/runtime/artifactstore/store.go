// Package artifactstore 是账号投影版本构件的唯一执行点（Go 侧）。
//
// Node 启动链只负责"哪些路径算版本构件"（策略），实际的文件系统动作——reflink 探测、
// 库内不可变树、硬链接/克隆、原子替换、账本——都由这里完成。账本格式与 Node 侧完全一致
// （artifact-store/ledger/<sha256(abs path)[:16]>.json），因此迁移期间两边可以互读。
//
// 安全性：
//   - 目标位置在投影外（父目录已是共享软链）→ shared-external，不重复铺；
//   - 账本记录 dev+ino（字符串，Windows 64 位 File ID 不丢精度）；对不上就重新共享；
//   - 内容变化（安装器重装）才刷新库内树，指纹只算路径+大小，不含权限位；
//   - 删除只读树前先放开目录写权限。
package artifactstore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Request 是 Node 传入的一次投影准备请求。
type Request struct {
	Provider        string     `json:"provider"`
	ProjectionRoot  string     `json:"projectionRoot"`
	StoreRoot       string     `json:"storeRoot"`
	ProjectionsRoot string     `json:"projectionsRoot"`
	Platform        string     `json:"platform"`
	Artifacts       []Artifact `json:"artifacts"`
}

// Artifact 是一个待共享的版本构件。
type Artifact struct {
	CLI     string `json:"cli"`
	Version string `json:"version"`
	Path    string `json:"path"`
}

// VersionResult 是单个构件的处理结果。
type VersionResult struct {
	CLI       string `json:"cli"`
	Version   string `json:"version"`
	Action    string `json:"action"`
	Strategy  string `json:"strategy"`
	StorePath string `json:"storePath"`
}

// Response 是 CLI 输出。
type Response struct {
	OK       bool            `json:"ok"`
	Versions []VersionResult `json:"versions"`
	Errors   []string        `json:"errors"`
}

var reflinkCache sync.Map // platform+"\x00"+dir -> bool

// Ensure 处理一次请求。
func Ensure(request Request) Response {
	response := Response{OK: true}
	projectionRoot := strings.TrimSpace(request.ProjectionRoot)
	storeRoot := strings.TrimSpace(request.StoreRoot)
	if projectionRoot == "" || storeRoot == "" {
		response.OK = false
		response.Errors = append(response.Errors, "projectionRoot/storeRoot required")
		return response
	}
	projectionReal, _ := filepath.EvalSymlinks(projectionRoot)
	seen := make(map[string]bool)
	for _, artifact := range request.Artifacts {
		artifact.CLI = strings.TrimSpace(artifact.CLI)
		artifact.Version = strings.TrimSpace(artifact.Version)
		if artifact.CLI == "" || artifact.Version == "" || strings.TrimSpace(artifact.Path) == "" {
			continue
		}
		realPath, err := filepath.EvalSymlinks(artifact.Path)
		if err != nil {
			realPath = artifact.Path
		}
		if projectionReal != "" && filepath.Clean(realPath) != filepath.Clean(artifact.Path) &&
			!strings.HasPrefix(realPath, projectionReal+string(filepath.Separator)) {
			response.Versions = append(response.Versions, VersionResult{
				CLI: artifact.CLI, Version: artifact.Version,
				Action: "shared-external", Strategy: "symlink-parent",
			})
			continue
		}
		if seen[realPath] {
			continue
		}
		seen[realPath] = true
		result, err := share(request, artifact)
		if err != nil {
			response.OK = false
			response.Errors = append(response.Errors, fmt.Sprintf("%s@%s: %v", artifact.CLI, artifact.Version, err))
			continue
		}
		response.Versions = append(response.Versions, result)
	}
	return response
}

func share(request Request, artifact Artifact) (VersionResult, error) {
	platform := normalizePlatform(request.Platform)
	key := treeKey(request.Provider, artifact.CLI, artifact.Version, platform)
	storePath := filepath.Join(request.StoreRoot, "trees", key)
	manifestPath := filepath.Join(request.StoreRoot, "trees", "."+filepath.Base(storePath)+".fingerprint.json")
	ledgerPath := ledgerPathFor(request.StoreRoot, artifact.Path)

	ledger := readLedger(ledgerPath)
	if entry, ok := ledger.Entries[ledgerKey(artifact.CLI, artifact.Version)]; ok && entry.StoreKey == key {
		if identity, err := fileIdentity(artifact.Path); err == nil &&
			identity.Dev == string(entry.Dev) && identity.Ino == string(entry.Ino) {
			return VersionResult{CLI: artifact.CLI, Version: artifact.Version, Action: "unchanged", Strategy: strategyName(request.StoreRoot, platform), StorePath: storePath}, nil
		}
	}

	// 库内没有内容：从投影搬进来。
	if !pathExists(storePath) {
		if err := materialize(artifact.Path, storePath, request.StoreRoot); err != nil {
			if !pathExists(storePath) {
				return VersionResult{}, err
			}
		}
	} else if info, err := os.Lstat(artifact.Path); err == nil && !frozenRoot(info) {
		// 安装器刚写出的可写副本：内容不同才刷新库。
		storeFingerprint := readManifestFingerprint(manifestPath)
		if storeFingerprint == "" {
			storeFingerprint = fingerprintTree(storePath)
		}
		projectionFingerprint := fingerprintTree(artifact.Path)
		if storeFingerprint != "" && projectionFingerprint != "" && storeFingerprint != projectionFingerprint {
			if err := refresh(artifact.Path, storePath, request.StoreRoot); err != nil {
				return VersionResult{}, err
			}
			_ = os.Remove(manifestPath)
		}
	}
	if readManifestFingerprint(manifestPath) == "" {
		if fp := fingerprintTree(storePath); fp != "" {
			writeManifest(manifestPath, fp)
		}
	}

	strategy := resolveStrategy(request.StoreRoot, platform)
	installed, effective, err := install(artifact.Path, storePath, strategy, platform)
	if err != nil {
		return VersionResult{}, err
	}
	if identity, err := fileIdentity(artifact.Path); err == nil {
		recordLedger(ledgerPath, artifact, key, identity, readManifestFingerprint(manifestPath))
	}
	return VersionResult{CLI: artifact.CLI, Version: artifact.Version, Action: installed, Strategy: effective, StorePath: storePath}, nil
}

// install 用临时目录原子替换投影里的构件。
func install(projectionPath, storePath, strategy, platform string) (string, string, error) {
	effective := strategy
	installed := map[string]string{"reflink": "reflinked", "hardlink": "hardlinked", "copy": "copied"}[effective]
	if installed == "" {
		installed = "linked"
	}
	parent := filepath.Dir(projectionPath)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return "", "", err
	}
	temporary := filepath.Join(parent, fmt.Sprintf(".%s.go-tmp-%d-%d", filepath.Base(projectionPath), os.Getpid(), time.Now().UnixNano()))
	cleanup := func() { thawDirs(temporary); _ = os.RemoveAll(temporary) }
	defer cleanup()
	if err := buildTemporary(storePath, temporary, effective, platform); err != nil {
		if effective == "reflink" {
			effective = "hardlink"
			installed = "hardlinked"
			_ = os.RemoveAll(temporary)
			if linkErr := buildTemporary(storePath, temporary, effective, platform); linkErr != nil {
				effective = "copy"
				installed = "copied"
				_ = os.RemoveAll(temporary)
				if copyErr := buildTemporary(storePath, temporary, effective, platform); copyErr != nil {
					return "", "", copyErr
				}
			}
		} else {
			return "", "", err
		}
	}
	if pathExists(projectionPath) {
		backup := temporary + ".old"
		thawDirs(projectionPath)
		if err := os.Rename(projectionPath, backup); err != nil {
			return "", "", err
		}
		if err := os.Rename(temporary, projectionPath); err != nil {
			_ = os.Rename(backup, projectionPath)
			return "", "", err
		}
		thawDirs(backup)
		_ = os.RemoveAll(backup)
	} else if err := os.Rename(temporary, projectionPath); err != nil {
		return "", "", err
	}
	return installed, effective, nil
}

func buildTemporary(storePath, temporary, strategy, platform string) error {
	info, err := os.Lstat(storePath)
	if err != nil {
		return err
	}
	if strategy == "reflink" {
		if err := platformClone(storePath, temporary, platform, info.IsDir()); err != nil {
			return err
		}
	} else if info.IsDir() {
		if err := linkTree(storePath, temporary); err != nil {
			return err
		}
	} else if err := os.Link(storePath, temporary); err != nil {
		return err
	}
	freezeTree(temporary)
	return nil
}

func linkTree(source, target string) error {
	if err := os.MkdirAll(target, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		from := filepath.Join(source, entry.Name())
		to := filepath.Join(target, entry.Name())
		switch {
		case entry.IsDir():
			if err := linkTree(from, to); err != nil {
				return err
			}
		case entry.Type()&os.ModeSymlink != 0:
			link, err := os.Readlink(from)
			if err != nil {
				return err
			}
			if err := os.Symlink(link, to); err != nil {
				return err
			}
		case entry.Type().IsRegular():
			if err := os.Link(from, to); err != nil {
				return err
			}
		}
	}
	return nil
}

func materialize(projectionPath, storePath, storeRoot string) error {
	if err := os.MkdirAll(filepath.Join(storeRoot, "trees"), 0o755); err != nil {
		return err
	}
	staging := filepath.Join(storeRoot, "trees", fmt.Sprintf(".%s.staging-%d-%d", filepath.Base(storePath), os.Getpid(), time.Now().UnixNano()))
	if err := copyTree(projectionPath, staging); err != nil {
		thawDirs(staging)
		_ = os.RemoveAll(staging)
		if pathExists(storePath) {
			return nil
		}
		return err
	}
	freezeTree(staging)
	if err := os.Rename(staging, storePath); err != nil {
		thawDirs(staging)
		_ = os.RemoveAll(staging)
		if pathExists(storePath) {
			return nil
		}
		return err
	}
	return nil
}

func refresh(projectionPath, storePath, storeRoot string) error {
	aside := fmt.Sprintf("%s.stale-%d-%d", storePath, os.Getpid(), time.Now().UnixNano())
	thawDirs(storePath)
	if err := os.Rename(storePath, aside); err != nil {
		return err
	}
	if err := materialize(projectionPath, storePath, storeRoot); err != nil {
		_ = os.Rename(aside, storePath)
		return err
	}
	thawDirs(aside)
	_ = os.RemoveAll(aside)
	return nil
}

func copyTree(source, target string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if info.IsDir() {
		if err := os.MkdirAll(target, 0o755); err != nil {
			return err
		}
		entries, err := os.ReadDir(source)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := copyTree(filepath.Join(source, entry.Name()), filepath.Join(target, entry.Name())); err != nil {
				return err
			}
		}
		return os.Chmod(target, info.Mode().Perm())
	}
	if info.Mode()&os.ModeSymlink != 0 {
		link, err := os.Readlink(source)
		if err != nil {
			return err
		}
		return os.Symlink(link, target)
	}
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode().Perm())
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func resolveStrategy(storeRoot, platform string) string {
	if supportsReflink(storeRoot, platform) {
		return "reflink"
	}
	return "hardlink"
}

func strategyName(storeRoot, platform string) string {
	if supportsReflink(storeRoot, platform) {
		return "reflink"
	}
	return "hardlink"
}

func supportsReflink(directory, platform string) bool {
	if platform == "windows" {
		return false
	}
	key := platform + "\x00" + directory
	if value, ok := reflinkCache.Load(key); ok {
		return value.(bool)
	}
	probeBytes := int64(32 * 1024 * 1024)
	_ = os.MkdirAll(directory, 0o755)
	base := filepath.Join(directory, fmt.Sprintf(".go-reflink-probe-%d-%d", os.Getpid(), time.Now().UnixNano()))
	source := base + "-src"
	clone := base + "-dst"
	defer os.Remove(source)
	defer os.Remove(clone)
	supported := false
	if err := os.WriteFile(source, make([]byte, probeBytes), 0o600); err == nil {
		args := []string{"--reflink=always", source, clone}
		if platform == "darwin" {
			args = []string{"-c", source, clone}
		}
		for attempt := 0; attempt < 2 && !supported; attempt++ {
			before, beforeOK := freeBytes(directory)
			command := exec.Command("cp", args...)
			if err := command.Run(); err != nil {
				break
			}
			after, afterOK := freeBytes(directory)
			supported = beforeOK && afterOK && before > 0 && after > 0 && before-after < probeBytes/2
			if !supported {
				_ = os.Remove(clone)
			}
		}
	}
	reflinkCache.Store(key, supported)
	return supported
}

func platformClone(source, target, platform string, isDir bool) error {
	args := []string{"-c"}
	if platform == "linux" {
		args = []string{"--reflink=always"}
	}
	if platform != "darwin" && platform != "linux" {
		return errors.New("reflink_unsupported_platform")
	}
	if isDir {
		args = append(args, "-R")
	}
	args = append(args, source, target)
	return exec.Command("cp", args...).Run()
}

func freezeTree(root string) {
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		if info.IsDir() {
			_ = os.Chmod(path, 0o555)
			return nil
		}
		if info.Mode().IsRegular() {
			mode := os.FileMode(0o444)
			if info.Mode()&0o111 != 0 {
				mode = 0o555
			}
			_ = os.Chmod(path, mode)
		}
		return nil
	})
}

// thawDirs 只放开目录写权限：删除/改名只需要目录可写，保持文件只读可避免影响硬链接共享者。
func thawDirs(root string) {
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || !entry.IsDir() {
			return nil
		}
		_ = os.Chmod(path, 0o755)
		return nil
	})
}

func fingerprintTree(root string) string {
	info, err := os.Lstat(root)
	if err != nil {
		return ""
	}
	hash := sha256.New()
	if !info.IsDir() {
		if info.Mode()&os.ModeSymlink != 0 {
			return ""
		}
		fmt.Fprintf(hash, "f::%d\n", info.Size())
		return hex.EncodeToString(hash.Sum(nil))
	}
	var walk func(directory, relative string) bool
	walk = func(directory, relative string) bool {
		entries, err := os.ReadDir(directory)
		if err != nil {
			return false
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, entry := range entries {
			rel := entry.Name()
			if relative != "" {
				rel = relative + "/" + entry.Name()
			}
			full := filepath.Join(directory, entry.Name())
			info, err := os.Lstat(full)
			if err != nil {
				return false
			}
			switch {
			case info.Mode()&os.ModeSymlink != 0:
				link, _ := os.Readlink(full)
				fmt.Fprintf(hash, "l:%s:%s\n", rel, link)
			case info.IsDir():
				fmt.Fprintf(hash, "d:%s\n", rel)
				if !walk(full, rel) {
					return false
				}
			case info.Mode().IsRegular():
				fmt.Fprintf(hash, "f:%s:%d\n", rel, info.Size())
			}
		}
		return true
	}
	if !walk(root, "") {
		return ""
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func treeKey(provider, cli, version, platform string) string {
	raw := strings.Join([]string{provider, cli, version, platform}, "__")
	var builder strings.Builder
	for _, r := range raw {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || strings.ContainsRune("_.@-", r) {
			builder.WriteRune(r)
		} else {
			builder.WriteByte('_')
		}
	}
	return builder.String()
}

func normalizePlatform(value string) string {
	if strings.TrimSpace(value) == "" {
		return "darwin"
	}
	return strings.ToLower(strings.TrimSpace(value))
}

func pathExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func frozenRoot(info os.FileInfo) bool {
	return info.Mode().Perm()&0o200 == 0
}

// ---- 账本 ----

type idString string

func (value *idString) UnmarshalJSON(data []byte) error {
	text := strings.TrimSpace(string(data))
	if len(text) > 1 && text[0] == '"' {
		var decoded string
		if err := json.Unmarshal(data, &decoded); err != nil {
			return err
		}
		*value = idString(decoded)
		return nil
	}
	*value = idString(strings.Trim(text, "\""))
	return nil
}

type ledgerEntry struct {
	StoreKey    string   `json:"storeKey"`
	Dev         idString `json:"dev"`
	Ino         idString `json:"ino"`
	Fingerprint string   `json:"fingerprint"`
	RecordedAt  string   `json:"recordedAt"`
}

type ledgerDoc struct {
	ProjectionRoot string                 `json:"projectionRoot"`
	Entries        map[string]ledgerEntry `json:"entries"`
}

type manifest struct {
	Fingerprint string `json:"fingerprint"`
	RecordedAt  string `json:"recordedAt"`
}

func ledgerKey(cli, version string) string { return cli + "@" + version }

func ledgerPathFor(storeRoot, projectionPath string) string {
	absolute, _ := filepath.Abs(projectionPath)
	sum := sha256.Sum256([]byte(absolute))
	return filepath.Join(storeRoot, "ledger", hex.EncodeToString(sum[:])[:16]+".json")
}

func readLedger(path string) ledgerDoc {
	doc := ledgerDoc{Entries: map[string]ledgerEntry{}}
	raw, err := os.ReadFile(path)
	if err != nil {
		return doc
	}
	if err := json.Unmarshal(raw, &doc); err != nil || doc.Entries == nil {
		doc.Entries = map[string]ledgerEntry{}
	}
	return doc
}

func recordLedger(path string, artifact Artifact, storeKey string, identity fileIdentityValue, fingerprint string) {
	doc := readLedger(path)
	doc.ProjectionRoot = filepath.Dir(filepath.Dir(artifact.Path))
	doc.Entries[ledgerKey(artifact.CLI, artifact.Version)] = ledgerEntry{
		StoreKey: storeKey, Dev: idString(identity.Dev), Ino: idString(identity.Ino),
		Fingerprint: fingerprint, RecordedAt: time.Now().UTC().Format(time.RFC3339),
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, append(raw, '\n'), 0o600); err != nil {
		return
	}
	_ = os.Rename(temporary, path)
}

func readManifestFingerprint(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var doc manifest
	if err := json.Unmarshal(raw, &doc); err != nil {
		return ""
	}
	return doc.Fingerprint
}

func writeManifest(path, fingerprint string) {
	if fingerprint == "" {
		return
	}
	raw, err := json.MarshalIndent(manifest{Fingerprint: fingerprint, RecordedAt: time.Now().UTC().Format(time.RFC3339)}, "", "  ")
	if err != nil {
		return
	}
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, append(raw, '\n'), 0o600); err != nil {
		return
	}
	_ = os.Rename(temporary, path)
}

func freeBytes(directory string) (int64, bool) {
	return statfsFree(directory)
}

type fileIdentityValue struct {
	Dev string
	Ino string
}

func fileIdentity(path string) (fileIdentityValue, error) {
	dev, ino, err := identityForPath(path)
	if err != nil {
		return fileIdentityValue{}, err
	}
	return fileIdentityValue{Dev: dev, Ino: ino}, nil
}
