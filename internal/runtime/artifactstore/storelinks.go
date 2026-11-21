package artifactstore

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

// StoreLinkEntry 是"共享会话存储"的一次声明：把投影里的会话条目链回宿主那一份。
// 只有文件系统动作在这里；真实数据的接管（adopt，含 SQLite 合并）是 provider 逻辑，
// 由 Node 先跑完再把结果交过来。
type StoreLinkEntry struct {
	ProjectionRoot string     `json:"projectionRoot"`
	SharedRoot     string     `json:"sharedRoot"`
	DirEntries     [][]string `json:"dirEntries,omitempty"`
	FileEntries    [][]string `json:"fileEntries,omitempty"`
	SidecarEntries [][]string `json:"sidecarEntries,omitempty"`
	DiscardReal    bool       `json:"discardRealEntries,omitempty"`
}

// StoreLinkResult 与 Node 的 summary 对齐（adopt 相关字段由 Node 补）。
type StoreLinkResult struct {
	Linked     int      `json:"linked"`
	Discarded  int      `json:"discarded"`
	Unresolved []string `json:"unresolved,omitempty"`
	Skipped    string   `json:"skipped,omitempty"`
	Errors     []string `json:"errors,omitempty"`
}

// StoreLinkPruneEntry 清理"指向共享根但目标已消失"的悬挂链接。
type StoreLinkPruneEntry struct {
	ProjectionRoot string     `json:"projectionRoot"`
	SharedRoot     string     `json:"sharedRoot"`
	Keep           [][]string `json:"keep,omitempty"`
}

type StoreLinkPruneResult struct {
	Removed []string `json:"removed,omitempty"`
	Errors  []string `json:"errors,omitempty"`
}

func applyStoreLinks(request Request) []StoreLinkResult {
	results := make([]StoreLinkResult, 0, len(request.StoreLinks))
	for _, entry := range request.StoreLinks {
		results = append(results, applyStoreLink(entry, normalizePlatform(request.Platform)))
	}
	return results
}

func applyStoreLink(entry StoreLinkEntry, platform string) StoreLinkResult {
	result := StoreLinkResult{}
	projectionRoot := strings.TrimSpace(entry.ProjectionRoot)
	sharedRoot := strings.TrimSpace(entry.SharedRoot)
	if projectionRoot == "" || sharedRoot == "" {
		result.Skipped = "missing-root"
		return result
	}
	// Fail-closed：投影本身就是宿主（无 auth 投影时 provider 跑在真实 HOME 下），
	// 或共享根落在投影内部（自链接）——两种情况都绝不建链。
	if normalizeCompare(projectionRoot) == normalizeCompare(sharedRoot) {
		result.Skipped = "projection-is-shared-root"
		return result
	}
	if insidePath(sharedRoot, projectionRoot) {
		result.Skipped = "shared-root-inside-projection"
		return result
	}
	// 父目录整体链到共享根后，子条目再处理只会穿过链接看到共享侧实体
	//（空目录会被当残留删掉，随后 symlink 撞 EEXIST）。先把冗余的子声明收敛掉。
	entry = normalizeStoreLinkEntry(entry)
	context := storeLinkContext{entry: entry, platform: platform, result: &result}
	for _, segments := range entry.DirEntries {
		context.run(segments, context.ensureDirLink)
	}
	for _, segments := range entry.FileEntries {
		context.run(segments, func(segments []string) { context.ensureFileLink(segments, false) })
	}
	for _, segments := range entry.SidecarEntries {
		context.run(segments, func(segments []string) { context.ensureFileLink(segments, true) })
	}
	result.Unresolved = uniqueStrings(result.Unresolved)
	return result
}

// normalizeStoreLinkEntry 去掉被祖先目录条目覆盖的子条目：父目录一旦整体链到
// 共享根，子路径天然共享，再声明一次是冗余的（且会误判共享侧实体为投影残留）。
func normalizeStoreLinkEntry(entry StoreLinkEntry) StoreLinkEntry {
	entry.DirEntries = dropCoveredSegments(entry.DirEntries, nil)
	entry.FileEntries = dropCoveredSegments(entry.FileEntries, entry.DirEntries)
	entry.SidecarEntries = dropCoveredSegments(entry.SidecarEntries, entry.DirEntries)
	return entry
}

// dropCoveredSegments 按段数从短到长保留条目，已被 parents 或更短条目覆盖的直接丢弃。
func dropCoveredSegments(entries [][]string, parents [][]string) [][]string {
	if len(entries) == 0 {
		return entries
	}
	covered := make([][]string, 0, len(parents)+len(entries))
	for _, parent := range parents {
		if cleaned := cleanStoreSegments(parent); len(cleaned) > 0 {
			covered = append(covered, cleaned)
		}
	}
	sorted := make([][]string, 0, len(entries))
	for _, segments := range entries {
		if cleaned := cleanStoreSegments(segments); len(cleaned) > 0 {
			sorted = append(sorted, cleaned)
		}
	}
	sort.SliceStable(sorted, func(left, right int) bool { return len(sorted[left]) < len(sorted[right]) })
	result := make([][]string, 0, len(sorted))
	for _, segments := range sorted {
		if coveredBySegments(segments, covered) {
			continue
		}
		covered = append(covered, segments)
		result = append(result, segments)
	}
	return result
}

func cleanStoreSegments(segments []string) []string {
	cleaned := make([]string, 0, len(segments))
	for _, segment := range segments {
		if segment == "" {
			continue
		}
		cleaned = append(cleaned, segment)
	}
	return cleaned
}

func coveredBySegments(segments []string, covered [][]string) bool {
	for _, candidate := range covered {
		if len(candidate) > len(segments) {
			continue
		}
		match := true
		for index := range candidate {
			if candidate[index] != segments[index] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// coveredBySharedAncestor 判断 source 的某个祖先是否已经是指向共享根的链接。
// 归一化后这种声明本不该存在；这里再兜一层，兼容乱序或外部拼装的请求。
func coveredBySharedAncestor(source, sharedRoot string) bool {
	if normalizeCompare(sharedRoot) == "" {
		return false
	}
	for dir := filepath.Dir(source); ; {
		if info, err := lstatOrNil(dir); err == nil && info != nil && isLinkEntry(info, dir) {
			if target, err := os.Readlink(dir); err == nil {
				if !filepath.IsAbs(target) {
					target = filepath.Join(filepath.Dir(dir), target)
				}
				if insidePath(target, sharedRoot) {
					return true
				}
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return false
		}
		dir = parent
	}
}

type storeLinkContext struct {
	entry    StoreLinkEntry
	platform string
	result   *StoreLinkResult
}

func (context *storeLinkContext) run(segments []string, fn func([]string)) {
	label := strings.Join(segments, "/")
	defer func() {
		if recovered := recover(); recovered != nil {
			context.result.Errors = append(context.result.Errors, label+":error")
		}
	}()
	fn(segments)
}

func (context *storeLinkContext) ensureDirLink(segments []string) {
	source := filepath.Join(context.entry.ProjectionRoot, filepath.Join(segments...))
	target := filepath.Join(context.entry.SharedRoot, filepath.Join(segments...))
	// 兜底：声明乱序时，祖先已经链到共享根就说明这一段天然共享，不再重复处理。
	if coveredBySharedAncestor(source, context.entry.SharedRoot) {
		return
	}
	info, err := lstatOrNil(source)
	if err != nil {
		context.result.Errors = append(context.result.Errors, strings.Join(segments, "/")+":"+errnoName(err))
		return
	}
	if isLinkEntry(info, source) {
		if linkPointsTo(source, target) {
			return
		}
		if err := os.Remove(source); err != nil {
			context.result.Errors = append(context.result.Errors, strings.Join(segments, "/")+":"+errnoName(err))
			return
		}
	} else if info != nil {
		if !context.resolveRealEntry(source, info, strings.Join(segments, "/")) {
			return
		}
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		context.addError(segments, err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(source), 0o755); err != nil {
		context.addError(segments, err)
		return
	}
	if err := createStoreDirLink(target, source, context.platform); err != nil {
		context.addError(segments, err)
		return
	}
	context.result.Linked++
}

func (context *storeLinkContext) ensureFileLink(segments []string, dangling bool) {
	source := filepath.Join(context.entry.ProjectionRoot, filepath.Join(segments...))
	target := filepath.Join(context.entry.SharedRoot, filepath.Join(segments...))
	if coveredBySharedAncestor(source, context.entry.SharedRoot) {
		return
	}
	info, err := lstatOrNil(source)
	if err != nil {
		context.addError(segments, err)
		return
	}
	if isLinkEntry(info, source) {
		if linkPointsTo(source, target) {
			return
		}
		if err := os.Remove(source); err != nil {
			context.addError(segments, err)
			return
		}
	} else if info != nil {
		if !context.resolveRealEntry(source, info, strings.Join(segments, "/")) {
			return
		}
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		context.addError(segments, err)
		return
	}
	if existing, _ := lstatOrNil(target); existing == nil && !dangling {
		// 空文件是合法的全新 SQLite 数据库；wal/shm 保持悬挂——SQLite 会通过链接
		// 创建共享目标。
		if err := os.WriteFile(target, nil, 0o644); err != nil {
			context.addError(segments, err)
			return
		}
	}
	if err := os.MkdirAll(filepath.Dir(source), 0o755); err != nil {
		context.addError(segments, err)
		return
	}
	if err := os.Symlink(target, source); err != nil {
		context.addError(segments, err)
		return
	}
	context.result.Linked++
}

// resolveRealEntry 处理"共享路径上已有真实（非链接）数据"：
// 空目录可安全替换；有内容的真实数据只有 discardReal 才可丢弃，否则记 unresolved。
func (context *storeLinkContext) resolveRealEntry(source string, info os.FileInfo, label string) bool {
	if context.entry.DiscardReal || isDisposableEmptyDir(source, info) {
		if err := os.RemoveAll(source); err != nil {
			context.result.Errors = append(context.result.Errors, label+":"+errnoName(err))
			return false
		}
		context.result.Discarded++
		return true
	}
	context.result.Unresolved = append(context.result.Unresolved, label)
	return false
}

func (context *storeLinkContext) addError(segments []string, err error) {
	context.result.Errors = append(context.result.Errors, strings.Join(segments, "/")+":"+errnoName(err))
}

func createStoreDirLink(target, link, platform string) error {
	if isWindowsPlatform(platform) {
		// 与 Node 的 symlinkSync(..., 'junction') 等价：不需要额外权限。
		if err := createJunction(target, link); err == nil {
			return nil
		}
	}
	return os.Symlink(target, link)
}

func applyStoreLinkPrunes(request Request) []StoreLinkPruneResult {
	results := make([]StoreLinkPruneResult, 0, len(request.StoreLinkPrunes))
	for _, entry := range request.StoreLinkPrunes {
		results = append(results, applyStoreLinkPrune(entry))
	}
	return results
}

// applyStoreLinkPrune 只扫投影根的一级条目，只动「指向共享根且目标已不存在」的链接。
// 背景（2026-11-03 真机）：旧版本把宿主数据根下每个条目都链进投影，收窄声明后残留链接
// 悬空；应用在该路径 mkdir(recursive) 会直接 ENOENT，ZCode 迁移备份因此起不来。
func applyStoreLinkPrune(entry StoreLinkPruneEntry) StoreLinkPruneResult {
	result := StoreLinkPruneResult{}
	projectionRoot := strings.TrimSpace(entry.ProjectionRoot)
	sharedRoot := strings.TrimSpace(entry.SharedRoot)
	if projectionRoot == "" || sharedRoot == "" {
		return result
	}
	keep := make(map[string]bool, len(entry.Keep))
	for _, segments := range entry.Keep {
		keep[filepath.Join(projectionRoot, filepath.Join(segments...))] = true
	}
	children, err := os.ReadDir(projectionRoot)
	if err != nil {
		return result
	}
	for _, child := range children {
		entryPath := filepath.Join(projectionRoot, child.Name())
		if keep[entryPath] {
			continue
		}
		info, err := os.Lstat(entryPath)
		if err != nil || !isLinkEntry(info, entryPath) {
			continue
		}
		target, err := os.Readlink(entryPath)
		if err != nil {
			result.Errors = append(result.Errors, child.Name()+":"+errnoName(err))
			continue
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(entryPath), target)
		}
		if !insidePath(target, sharedRoot) {
			continue
		}
		if _, err := os.Stat(target); err == nil {
			continue
		} else if !os.IsNotExist(err) {
			result.Errors = append(result.Errors, child.Name()+":"+errnoName(err))
			continue
		}
		if err := os.Remove(entryPath); err != nil {
			result.Errors = append(result.Errors, child.Name()+":"+errnoName(err))
			continue
		}
		result.Removed = append(result.Removed, child.Name())
	}
	sort.Strings(result.Removed)
	return result
}

// normalizeCompare 对齐 Node：反斜杠/斜杠都当分隔符、去尾部斜杠、大小写不敏感
// （Windows 路径大小写不敏感；POSIX 上大小写不同本来也不会指向同一路径）。
func normalizeCompare(value string) string {
	text := strings.ToLower(strings.TrimSpace(value))
	if text == "" {
		return ""
	}
	text = strings.NewReplacer("\\", "/").Replace(text)
	text = strings.TrimRight(text, "/")
	return text
}

func insidePath(child, parent string) bool {
	childNorm := normalizeCompare(child)
	parentNorm := normalizeCompare(parent)
	if childNorm == "" || parentNorm == "" {
		return false
	}
	return childNorm == parentNorm || strings.HasPrefix(childNorm, parentNorm+"/")
}

func linkPointsTo(linkPath, target string) bool {
	link, err := os.Readlink(linkPath)
	if err != nil {
		return false
	}
	if !filepath.IsAbs(link) {
		link = filepath.Join(filepath.Dir(linkPath), link)
	}
	return normalizeCompare(link) == normalizeCompare(target)
}

// isLinkEntry 判定"这个条目是链接（符号链接或 Windows junction）"。
// Go 在 Windows 上会把 junction 报成 ModeIrregular（reparse tag 是挂载点），只用
// ModeSymlink 会漏判；能 readlink 出目标就算链接（悬挂链接也能读）。
func isLinkEntry(info os.FileInfo, path string) bool {
	if info == nil {
		return false
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return true
	}
	if _, err := os.Readlink(path); err == nil {
		return true
	}
	return false
}

// resolveRealPath 解析链接链（POSIX 符号链接 + Windows junction）。
//
// filepath.EvalSymlinks 在 Windows 上不解析挂载点重解析（junction），而共享目录恰好
// 用 junction；不自己走一遍 readlink，就会把"已链到投影外"的目录当成普通目录。
func resolveRealPath(target string) string {
	clean := filepath.Clean(target)
	for depth := 0; depth < 32; depth++ {
		// 先让标准库解析父目录链（POSIX 全解析；Windows 只解析符号链接）。
		if resolved, err := filepath.EvalSymlinks(clean); err == nil {
			clean = resolved
		}
		info, err := os.Lstat(clean)
		if err != nil {
			parent := filepath.Dir(clean)
			if parent == clean {
				return clean
			}
			return filepath.Join(resolveRealPath(parent), filepath.Base(clean))
		}
		// EvalSymlinks 在 Windows 不解析 junction，叶子节点自己再走一段 readlink。
		if !isLinkEntry(info, clean) {
			return clean
		}
		link, err := os.Readlink(clean)
		if err != nil {
			return clean
		}
		if !filepath.IsAbs(link) {
			link = filepath.Join(filepath.Dir(clean), link)
		}
		clean = filepath.Clean(link)
	}
	return clean
}

func lstatOrNil(target string) (os.FileInfo, error) {
	info, err := os.Lstat(target)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	return info, nil
}

func isDisposableEmptyDir(target string, info os.FileInfo) bool {
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	children, err := os.ReadDir(target)
	if err != nil {
		return false
	}
	return len(children) == 0
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

// errnoName 把 Go 的 syscall 错误映射回 Node 的 `error.code` 字符串，保证日志口径一致。
func errnoName(err error) string {
	if err == nil {
		return "error"
	}
	switch {
	case errors.Is(err, os.ErrNotExist):
		return "ENOENT"
	case errors.Is(err, os.ErrPermission):
		return "EACCES"
	case errors.Is(err, os.ErrExist):
		return "EEXIST"
	case errors.Is(err, syscall.ENOTDIR):
		return "ENOTDIR"
	case errors.Is(err, syscall.EISDIR):
		return "EISDIR"
	case errors.Is(err, syscall.ENOTEMPTY):
		return "ENOTEMPTY"
	case errors.Is(err, syscall.EXDEV):
		return "EXDEV"
	case errors.Is(err, syscall.EROFS):
		return "EROFS"
	case errors.Is(err, syscall.EINVAL):
		return "EINVAL"
	}
	var pathErr *os.PathError
	if errors.As(err, &pathErr) && pathErr.Err != nil {
		return errnoName(pathErr.Err)
	}
	return "error"
}
