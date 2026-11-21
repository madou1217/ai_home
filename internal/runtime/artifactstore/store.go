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
	"strconv"
	"strings"
	"sync"
	"time"

	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
	"github.com/madou1217/ai_home/internal/runtime/spacegc"
)

// Request 是 Node 传入的一次投影准备请求。
type Request struct {
	Provider        string                `json:"provider"`
	ProjectionRoot  string                `json:"projectionRoot"`
	StoreRoot       string                `json:"storeRoot"`
	ProjectionsRoot string                `json:"projectionsRoot"`
	Platform        string                `json:"platform"`
	HostHomeDir     string                `json:"hostHomeDir,omitempty"`
	Artifacts       []Artifact            `json:"artifacts"`
	Caches          []CacheEntry          `json:"caches,omitempty"`
	DataRoots       []DataRootEntry       `json:"dataRoots,omitempty"`
	Dedupe          []DedupeEntry         `json:"dedupe,omitempty"`
	StoreLinks      []StoreLinkEntry      `json:"storeLinks,omitempty"`
	StoreLinkPrunes []StoreLinkPruneEntry `json:"storeLinkPrunes,omitempty"`
	SkillLinks      []SkillLinkEntry      `json:"skillLinks,omitempty"`
	RuntimeHomes    []RuntimeHomeEntry    `json:"runtimeHomes,omitempty"`
	FamilyLinks     []FamilyLink          `json:"familyLinks,omitempty"`
	HardlinkRepairs []HardlinkRepair      `json:"hardlinkRepairs,omitempty"`
	BridgeLinks     *BridgeLinks          `json:"bridgeLinks,omitempty"`
	Prune           *PruneOptions         `json:"prune,omitempty"`
}

// DataRootEntry 是桌面 App 数据根（会话/数据库）声明：投影里应是指向宿主同一份的链接。
type DataRootEntry struct {
	Projection []string `json:"projection"`
	Host       []string `json:"host"`
}

// DedupeEntry 是"应用解压内容与宿主同版本"的逐文件硬链接去重声明。
type DedupeEntry struct {
	Projection []string `json:"projection"`
	Host       []string `json:"host"`
	StampFile  string   `json:"stampFile"`
}

// DataRootResult 汇总数据根链接结果；unresolved 表示两边都有真实数据，必须拒绝启动。
type DataRootResult struct {
	Linked     []string       `json:"linked,omitempty"`
	Adopted    []string       `json:"adopted,omitempty"`
	Unchanged  []string       `json:"unchanged,omitempty"`
	Unresolved []string       `json:"unresolved,omitempty"`
	Skipped    []string       `json:"skipped,omitempty"`
	Failed     []CacheFailure `json:"failed,omitempty"`
}

// DedupeResult 汇总逐文件去重统计。
type DedupeResult struct {
	Linked        int      `json:"linked"`
	AlreadyShared int      `json:"alreadyShared"`
	Failed        int      `json:"failed"`
	Bytes         int64    `json:"bytes"`
	Skipped       []string `json:"skipped,omitempty"`
}

// CacheEntry 是 Node 按 provider 策略算出的宿主共享缓存声明。
type CacheEntry struct {
	Projection    []string `json:"projection"`
	Host          []string `json:"host"`
	ProjectionDir bool     `json:"projectionDir,omitempty"`
	Exclude       []string `json:"exclude,omitempty"`
}

// CacheResult 汇总缓存链接结果（路径为投影内相对路径）。
type CacheResult struct {
	Linked   []string       `json:"linked,omitempty"`
	Replaced []string       `json:"replaced,omitempty"`
	Adopted  []string       `json:"adopted,omitempty"`
	Failed   []CacheFailure `json:"failed,omitempty"`
}

type CacheFailure struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// PruneOptions 控制旧版本回收；由 Node 传入保留策略，Go 执行。
type PruneOptions struct {
	KeepVersions  int             `json:"keepVersions"`
	TrashDir      string          `json:"trashDir"`
	GraceDays     int             `json:"graceDays"`
	LogMaxAgeDays int             `json:"logMaxAgeDays"`
	LogDirNames   []string        `json:"logDirNames"`
	LogParents    []string        `json:"logParents"`
	StoreGC       *StoreGCOptions `json:"storeGc,omitempty"`
}

// StoreGCOptions 是库内版本树回收：Node 传仍被投影引用的 key 集合。
type StoreGCOptions struct {
	KeepVersions   int      `json:"keepVersions"`
	ReferencedKeys []string `json:"referencedKeys"`
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
	OK              bool                   `json:"ok"`
	Versions        []VersionResult        `json:"versions"`
	Pruned          []PrunedVersion        `json:"pruned,omitempty"`
	StorePruned     []PrunedVersion        `json:"storePruned,omitempty"`
	Emptied         int                    `json:"emptied,omitempty"`
	Caches          *CacheResult           `json:"caches,omitempty"`
	DataRoots       *DataRootResult        `json:"dataRoots,omitempty"`
	Dedupe          *DedupeResult          `json:"dedupe,omitempty"`
	StoreLinks      []StoreLinkResult      `json:"storeLinks,omitempty"`
	StoreLinkPrunes []StoreLinkPruneResult `json:"storeLinkPrunes,omitempty"`
	SkillLinks      []SkillLinkResult      `json:"skillLinks,omitempty"`
	RuntimeHomes    []RuntimeHomeResult    `json:"runtimeHomes,omitempty"`
	FamilyLinks     *FamilyLinkResult      `json:"familyLinks,omitempty"`
	HardlinkRepairs []HardlinkRepairResult `json:"hardlinkRepairs,omitempty"`
	BridgeLinks     *BridgeLinkResult      `json:"bridgeLinks,omitempty"`
	Errors          []string               `json:"errors"`
}

// PrunedVersion 是被移入回收站的旧版本。
type PrunedVersion struct {
	Path      string `json:"path"`
	Reason    string `json:"reason"`
	SizeBytes int64  `json:"sizeBytes"`
}

var reflinkCache sync.Map // platform+"\x00"+dir -> bool

// Ensure 处理一次请求。
func Ensure(request Request) Response {
	response := Response{OK: true}
	projectionRoot := strings.TrimSpace(request.ProjectionRoot)
	storeRoot := strings.TrimSpace(request.StoreRoot)
	if projectionRoot == "" || (len(request.Artifacts) > 0 && storeRoot == "") {
		response.OK = false
		response.Errors = append(response.Errors, "projectionRoot/storeRoot required")
		return response
	}
	// 共享会话存储的建链/悬挂链接清理（adopt 的 provider 逻辑已在 Node 侧跑完）。
	if len(request.StoreLinks) > 0 {
		response.StoreLinks = applyStoreLinks(request)
	}
	if len(request.StoreLinkPrunes) > 0 {
		response.StoreLinkPrunes = applyStoreLinkPrunes(request)
	}
	if len(request.SkillLinks) > 0 {
		response.SkillLinks = applySkillLinks(request)
	}
	if len(request.RuntimeHomes) > 0 {
		response.RuntimeHomes = applyRuntimeHomes(request)
	}
	if len(request.FamilyLinks) > 0 {
		applied := applyFamilyLinks(request)
		response.FamilyLinks = &applied
	}
	if len(request.HardlinkRepairs) > 0 {
		response.HardlinkRepairs = applyHardlinkRepairs(request)
	}
	if request.BridgeLinks != nil {
		applied := applyBridgeLinks(*request.BridgeLinks, request.Platform)
		response.BridgeLinks = &applied
	}
	if len(request.DataRoots) > 0 {
		response.DataRoots = linkDataRoots(request)
	}
	if len(request.Caches) > 0 {
		response.Caches = linkCaches(request)
	}
	projectionReal := resolveRealPath(projectionRoot)
	seen := make(map[string]bool)
	for _, artifact := range request.Artifacts {
		artifact.CLI = strings.TrimSpace(artifact.CLI)
		artifact.Version = strings.TrimSpace(artifact.Version)
		if artifact.CLI == "" || artifact.Version == "" || strings.TrimSpace(artifact.Path) == "" {
			continue
		}
		realPath := resolveRealPath(artifact.Path)
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
	// 去重放在构件铺好之后：需要应用目录已经就位，且不干扰版本树的 inode 账本。
	if len(request.Dedupe) > 0 {
		response.Dedupe = dedupeSharedHostFiles(request)
	}
	if request.Prune != nil {
		pruneVersions(request, &response)
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
			// inode 会被文件系统复用：安装器删掉再装回同一路径时可能拿到同一个 inode。
			// 必须是"我们冻结的树"才算 unchanged；可写副本一律重新核对/共享。
			if info, statErr := os.Lstat(artifact.Path); statErr == nil && frozenRoot(info) {
				return VersionResult{CLI: artifact.CLI, Version: artifact.Version, Action: "unchanged", Strategy: strategyName(request.StoreRoot, platform), StorePath: storePath}, nil
			}
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
		info, err := entry.Info()
		if err != nil {
			continue
		}
		switch {
		case entry.IsDir():
			if err := linkTree(from, to); err != nil {
				return err
			}
		case isLinkEntry(info, from):
			// junction 在 Go 里可能报 ModeIrregular，不能只认 ModeSymlink。
			link, err := os.Readlink(from)
			if err != nil {
				return err
			}
			if err := os.Symlink(link, to); err != nil {
				return err
			}
		case info.Mode().IsRegular():
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
	if isLinkEntry(info, source) {
		link, err := os.Readlink(source)
		if err != nil {
			return err
		}
		return os.Symlink(link, target)
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
	if isWindowsPlatform(platform) {
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

// isWindowsPlatform 同时接受 Node 的 "win32" 和内部可读的 "windows"：
// 以前只比 "windows"，于是 win32 请求永远走不到 junction 分支，退化成需要特权的
// os.Symlink（普通用户直接 EPERM），reflink 探测也会去调用不存在的 cp。
func isWindowsPlatform(platform string) bool {
	return platform == "win32" || platform == "windows"
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

// pruneVersions 是 Go 侧的旧版本回收：Node 传保留策略，Go 负责在用判定、移入回收站和清空。
func pruneVersions(request Request, response *Response) {
	options := request.Prune
	if options == nil {
		return
	}
	keep := options.KeepVersions
	if keep < 0 {
		keep = 0
	}
	projectionReal := resolveRealPath(request.ProjectionRoot)
	groups := map[string][]Artifact{}
	seen := map[string]bool{}
	for _, artifact := range request.Artifacts {
		realPath := resolveRealPath(artifact.Path)
		if projectionReal != "" && !strings.HasPrefix(realPath, projectionReal+string(filepath.Separator)) {
			// 父目录已是共享软链：这份内容不属于本账号，不能回收。
			continue
		}
		if seen[artifact.Path] {
			continue
		}
		seen[artifact.Path] = true
		groups[artifact.CLI] = append(groups[artifact.CLI], artifact)
	}
	// 在用判定失败时保守跳过，避免删除正在运行的版本。
	held, heldKnown := spacegc.HeldPaths()
	if heldKnown {
		for cli, artifacts := range groups {
			sort.SliceStable(artifacts, func(i, j int) bool {
				return compareVersions(artifacts[i].Version, artifacts[j].Version) < 0
			})
			stale := len(artifacts) - keep
			if stale <= 0 {
				continue
			}
			for _, artifact := range artifacts[:stale] {
				if spacegc.PathHeld(held, artifact.Path) {
					continue
				}
				size := treeSize(artifact.Path)
				if err := moveToTrash(artifact.Path, options.TrashDir); err != nil {
					response.Errors = append(response.Errors, fmt.Sprintf("trash %s: %v", artifact.Path, err))
					response.OK = false
					continue
				}
				response.Pruned = append(response.Pruned, PrunedVersion{Path: artifact.Path, Reason: "old-version", SizeBytes: size})
			}
			_ = cli
		}
	}
	pruneLogs(request, response)
	pruneStoreTrees(request, response)
	if strings.TrimSpace(options.TrashDir) != "" {
		response.Emptied += emptyTrash(options.TrashDir, options.GraceDays)
	}
}

// pruneLogs 对齐 Node：只扫 projection/<parent>/<traces|logs> 的直接子项；
// 修改时间与访问时间取较新者；目录内任何子文件较新都保留整个目录。
func pruneLogs(request Request, response *Response) {
	options := request.Prune
	if options == nil || options.LogMaxAgeDays <= 0 || strings.TrimSpace(request.ProjectionRoot) == "" {
		return
	}
	cutoff := time.Now().Add(-time.Duration(options.LogMaxAgeDays) * 24 * time.Hour)
	parents := options.LogParents
	if len(parents) == 0 {
		parents = append(codebuddyfamilystorage.ConfigDirs(),
			providerroot.ConfigDir("qoder"),
			providerroot.ConfigDir("qodercn"))
	}
	names := options.LogDirNames
	if len(names) == 0 {
		names = []string{"traces", "logs"}
	}
	for _, parent := range parents {
		for _, name := range names {
			directory := filepath.Join(request.ProjectionRoot, parent, name)
			entries, err := os.ReadDir(directory)
			if err != nil {
				continue
			}
			for _, entry := range entries {
				target := filepath.Join(directory, entry.Name())
				info, err := entry.Info()
				if err != nil {
					continue
				}
				if !lastActivity(info).Before(cutoff) {
					continue
				}
				if entry.IsDir() && directoryRecentlyWritten(target, cutoff) {
					continue
				}
				size := treeSize(target)
				if err := moveToTrash(target, options.TrashDir); err != nil {
					response.Errors = append(response.Errors, fmt.Sprintf("trash %s: %v", target, err))
					response.OK = false
					continue
				}
				response.Pruned = append(response.Pruned, PrunedVersion{Path: target, Reason: "stale-" + name, SizeBytes: size})
			}
		}
	}
}

func directoryRecentlyWritten(directory string, cutoff time.Time) bool {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return true
	}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if !lastActivity(info).Before(cutoff) {
			return true
		}
		if entry.IsDir() && directoryRecentlyWritten(filepath.Join(directory, entry.Name()), cutoff) {
			return true
		}
	}
	return false
}

func lastActivity(info os.FileInfo) time.Time {
	last := info.ModTime()
	if accessed := accessTime(info); accessed.After(last) {
		last = accessed
	}
	return last
}

func moveToTrash(target, trashDir string) error {
	thawDirs(target)
	_ = os.Chmod(filepath.Dir(target), 0o755)
	root := strings.TrimSpace(trashDir)
	if root == "" {
		return os.RemoveAll(target)
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	now := time.Now()
	stamp := strings.NewReplacer(":", "-", ".", "-").Replace(now.UTC().Format("2006-01-02T15:04:05.000Z"))
	destination := filepath.Join(root, fmt.Sprintf("%s-%s-%d", stamp, filepath.Base(target), os.Getpid()))
	if err := os.Rename(target, destination); err != nil {
		return err
	}
	// 回收站宽限期从"移入时间"算，不能沿用源目录的旧 mtime；否则旧日志/旧版本
	// 会在同一次 GC 里被立刻清掉，宽限期形同虚设。
	_ = os.Chtimes(destination, now, now)
	return nil
}

func emptyTrash(trashDir string, graceDays int) int {
	if graceDays < 0 {
		return 0
	}
	cutoff := time.Now().Add(-time.Duration(graceDays) * 24 * time.Hour)
	entries, err := os.ReadDir(trashDir)
	if err != nil {
		return 0
	}
	removed := 0
	for _, entry := range entries {
		target := filepath.Join(trashDir, entry.Name())
		info, err := entry.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		thawDirs(target)
		if err := os.RemoveAll(target); err == nil {
			removed++
		}
	}
	return removed
}

func compareVersions(left, right string) int {
	a := versionParts(left)
	b := versionParts(right)
	length := len(a)
	if len(b) > length {
		length = len(b)
	}
	for index := 0; index < length; index++ {
		av, bv := 0, 0
		if index < len(a) {
			av = a[index]
		}
		if index < len(b) {
			bv = b[index]
		}
		if av != bv {
			return av - bv
		}
	}
	return 0
}

func versionParts(version string) []int {
	parts := strings.FieldsFunc(version, func(r rune) bool { return r == '.' || r == '-' })
	result := make([]int, 0, len(parts))
	for _, part := range parts {
		value, err := strconv.Atoi(part)
		if err != nil {
			value = 0
		}
		result = append(result, value)
	}
	return result
}

func treeSize(root string) int64 {
	var total int64
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		if info, err := entry.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}
func linkCaches(request Request) *CacheResult {
	result := &CacheResult{}
	projectionRoot := strings.TrimSpace(request.ProjectionRoot)
	hostHomeDir := strings.TrimSpace(request.HostHomeDir)
	if projectionRoot == "" || hostHomeDir == "" || sameAbsolutePath(projectionRoot, hostHomeDir) {
		return result
	}
	entries := make([]CacheEntry, 0, len(request.Caches))
	for _, entry := range request.Caches {
		if !entry.ProjectionDir {
			entries = append(entries, entry)
		}
	}
	for _, entry := range request.Caches {
		if entry.ProjectionDir {
			entries = append(entries, entry)
		}
	}
	for _, entry := range entries {
		if entry.ProjectionDir {
			linkDirectoryEntry(request, entry, result)
			continue
		}
		relative := filepath.Join(entry.Projection...)
		projectionPath := filepath.Join(projectionRoot, filepath.Join(entry.Projection...))
		hostTarget := filepath.Join(hostHomeDir, filepath.Join(entry.Host...))
		outcome, err := linkOneCache(projectionPath, hostTarget, request.Platform)
		if err != nil {
			result.Failed = append(result.Failed, CacheFailure{Path: relative, Error: err.Error()})
			continue
		}
		appendCacheOutcome(result, outcome, relative)
	}
	return result
}

func linkDirectoryEntry(request Request, entry CacheEntry, result *CacheResult) {
	projectionRoot := strings.TrimSpace(request.ProjectionRoot)
	hostHomeDir := strings.TrimSpace(request.HostHomeDir)
	relativeDir := filepath.Join(entry.Projection...)
	projectionDir := filepath.Join(projectionRoot, relativeDir)
	hostDir := filepath.Join(hostHomeDir, filepath.Join(entry.Host...))
	excluded := make(map[string]bool, len(entry.Exclude))
	for _, name := range entry.Exclude {
		excluded[name] = true
	}
	names := make(map[string]bool)
	for _, dir := range []string{projectionDir, hostDir} {
		if entries, err := os.ReadDir(dir); err == nil {
			for _, child := range entries {
				names[child.Name()] = true
			}
		}
	}
	list := make([]string, 0, len(names))
	for name := range names {
		if name == "" || strings.HasPrefix(name, ".prepare-") || excluded[name] {
			continue
		}
		list = append(list, name)
	}
	sort.Strings(list)
	for _, name := range list {
		relative := filepath.Join(relativeDir, name)
		outcome, err := linkOneCache(filepath.Join(projectionDir, name), filepath.Join(hostDir, name), request.Platform)
		if err != nil {
			result.Failed = append(result.Failed, CacheFailure{Path: relative, Error: err.Error()})
			continue
		}
		appendCacheOutcome(result, outcome, relative)
	}
}

func appendCacheOutcome(result *CacheResult, outcome, relative string) {
	switch outcome {
	case "linked":
		result.Linked = append(result.Linked, relative)
	case "replaced":
		result.Replaced = append(result.Replaced, relative)
	case "adopted":
		result.Adopted = append(result.Adopted, relative)
	}
}

func linkOneCache(projectionPath, hostTarget, platform string) (string, error) {
	projectionReal := resolveRealPath(projectionPath)
	hostReal := resolveRealPath(hostTarget)
	if projectionReal != "" && projectionReal == hostReal {
		return "unchanged", nil
	}
	info, err := os.Lstat(projectionPath)
	if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	if isLinkEntry(info, projectionPath) {
		if link, err := os.Readlink(projectionPath); err == nil {
			target := link
			if !filepath.IsAbs(target) {
				target = filepath.Join(filepath.Dir(projectionPath), target)
			}
			if sameAbsolutePath(target, hostTarget) {
				return "unchanged", nil
			}
		}
	}
	realCopy := info != nil && !isLinkEntry(info, projectionPath)
	outcome := "linked"
	if !pathExists(hostTarget) {
		if !realCopy {
			return "skipped", nil
		}
		if err := os.MkdirAll(filepath.Dir(hostTarget), 0o755); err != nil {
			return "", err
		}
		if err := os.Rename(projectionPath, hostTarget); err != nil {
			return "", err
		}
		outcome = "adopted"
		info = nil
	} else if realCopy {
		thawAll(projectionPath)
		if err := os.RemoveAll(projectionPath); err != nil {
			return "", err
		}
		outcome = "replaced"
		info = nil
	} else if info != nil {
		if err := os.Remove(projectionPath); err != nil {
			return "", err
		}
	}
	if err := os.MkdirAll(filepath.Dir(projectionPath), 0o755); err != nil {
		return "", err
	}
	target, err := filepath.Abs(hostTarget)
	if err != nil {
		return "", err
	}
	if err := createDirectoryLink(target, projectionPath, platform); err != nil {
		return "", err
	}
	return outcome, nil
}

func createDirectoryLink(target, link, platform string) error {
	if isWindowsPlatform(platform) {
		// Node 用 junction；Go 的 os.Symlink 在 Windows 需要额外权限，这里沿用 mklink /J。
		if info, err := os.Stat(target); err == nil && info.IsDir() {
			if err := createJunction(target, link); err == nil {
				return nil
			}
		}
	}
	return os.Symlink(target, link)
}

func thawAll(root string) {
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		if info.IsDir() {
			_ = os.Chmod(path, 0o755)
		} else if info.Mode().IsRegular() {
			mode := os.FileMode(0o644)
			if info.Mode()&0o111 != 0 {
				mode = 0o755
			}
			_ = os.Chmod(path, mode)
		}
		return nil
	})
}

func sameAbsolutePath(left, right string) bool {
	absoluteLeft, errLeft := filepath.Abs(left)
	absoluteRight, errRight := filepath.Abs(right)
	return errLeft == nil && errRight == nil && filepath.Clean(absoluteLeft) == filepath.Clean(absoluteRight)
}
func pruneStoreTrees(request Request, response *Response) {
	options := request.Prune
	if options == nil || options.StoreGC == nil || strings.TrimSpace(request.StoreRoot) == "" {
		return
	}
	treesDir := filepath.Join(request.StoreRoot, "trees")
	entries, err := os.ReadDir(treesDir)
	if err != nil {
		return
	}
	keep := options.StoreGC.KeepVersions
	if keep < 0 {
		keep = 0
	}
	referenced := make(map[string]bool, len(options.StoreGC.ReferencedKeys))
	for _, key := range options.StoreGC.ReferencedKeys {
		referenced[key] = true
	}
	groups := map[string][]struct {
		key  string
		path string
		ver  string
	}{}
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		parts := strings.Split(entry.Name(), "__")
		if len(parts) != 4 {
			continue
		}
		groupKey := parts[0] + "__" + parts[1] + "__" + parts[3]
		groups[groupKey] = append(groups[groupKey], struct {
			key  string
			path string
			ver  string
		}{key: entry.Name(), path: filepath.Join(treesDir, entry.Name()), ver: parts[2]})
	}
	held, heldKnown := spacegc.HeldPaths()
	for _, artifacts := range groups {
		sort.SliceStable(artifacts, func(i, j int) bool {
			return compareVersions(artifacts[i].ver, artifacts[j].ver) < 0
		})
		stale := len(artifacts) - keep
		if stale <= 0 {
			continue
		}
		for _, artifact := range artifacts[:stale] {
			if referenced[artifact.key] {
				continue
			}
			if heldKnown && spacegc.PathHeld(held, artifact.path) {
				continue
			}
			size := treeSize(artifact.path)
			if err := moveToTrash(artifact.path, options.TrashDir); err != nil {
				response.Errors = append(response.Errors, fmt.Sprintf("trash %s: %v", artifact.path, err))
				response.OK = false
				continue
			}
			_ = os.Remove(artifact.path + ".fingerprint.json")
			_ = os.Remove(filepath.Join(treesDir, "."+filepath.Base(artifact.path)+".fingerprint.json"))
			response.StorePruned = append(response.StorePruned, PrunedVersion{Path: artifact.path, Reason: "stale-store-tree", SizeBytes: size})
		}
	}
}
