//go:build windows

package artifactstore

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// 这组测试只做真实文件系统操作（不 mock）：junction 的语义是 Windows 内核行为，
// 只能靠真机断言。它们固定住"共享目录只读、账号侧可删"所依赖的几条契约，
// 防止 Go/Windows 升级后悄悄改变删除或重命名语义、进而伤到共享数据。

const fsctlGetReparsePoint = 0x000900A8

// reparseTag 读取路径上的重解析标签，区分 junction（挂载点）与符号链接。
func reparseTag(t *testing.T, path string) uint32 {
	t.Helper()
	pointer, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		t.Fatalf("utf16 %s: %v", path, err)
	}
	handle, err := syscall.CreateFile(
		pointer,
		0,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil,
		syscall.OPEN_EXISTING,
		syscall.FILE_FLAG_BACKUP_SEMANTICS|syscall.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if err != nil {
		t.Fatalf("open reparse point %s: %v", path, err)
	}
	defer syscall.CloseHandle(handle)
	buffer := make([]byte, 16*1024)
	var returned uint32
	if err := syscall.DeviceIoControl(handle, fsctlGetReparsePoint, nil, 0, &buffer[0], uint32(len(buffer)), &returned, nil); err != nil {
		t.Fatalf("get reparse point %s: %v", path, err)
	}
	return binary.LittleEndian.Uint32(buffer[:4])
}

func assertJunction(t *testing.T, path, target string) {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("lstat %s: %v", path, err)
	}
	if !isLinkEntry(info, path) {
		t.Fatalf("%s 不是链接（mode=%v）", path, info.Mode())
	}
	if tag := reparseTag(t, path); tag != ioReparseTagMountPoint {
		t.Fatalf("%s 的重解析标签是 0x%X，不是 junction", path, tag)
	}
	stat, err := os.Stat(path)
	if err != nil || !stat.IsDir() {
		t.Fatalf("%s 穿透后不是目录（err=%v）", path, err)
	}
	// 生产代码用自己的解析器（filepath.EvalSymlinks 在 Windows 不解析 junction）。
	resolved := resolveRealPath(path)
	// 必须比较"是不是同一个目录"，不能比路径字符串：GitHub runner 的 %TEMP% 是 8.3
	// 短名（RUNNER~1），解析后变成长名（runneradmin），字符串必然不相等。
	if !samePathIdentity(resolved, target) {
		t.Fatalf("%s 解析到 %s，期望 %s（不是同一目录）", path, resolved, target)
	}
}

// samePathIdentity 用 os.SameFile 判断两个路径是否指向同一个文件/目录。
// 8.3 短名与长名、大小写差异都不会影响判断。
func samePathIdentity(left, right string) bool {
	leftInfo, err := os.Stat(left)
	if err != nil {
		return false
	}
	rightInfo, err := os.Stat(right)
	if err != nil {
		return false
	}
	return os.SameFile(leftInfo, rightInfo)
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(raw)
}

func TestJunctionCreationAndPassthrough(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "host", "shared")
	link := filepath.Join(root, "projection", "shared")
	writeFile(t, filepath.Join(target, "keep.txt"), "original")

	if err := createJunction(target, link); err != nil {
		t.Fatalf("createJunction: %v", err)
	}
	assertJunction(t, link, target)

	// 通过链接读、写都必须落在目标目录。
	if got := mustRead(t, filepath.Join(link, "keep.txt")); got != "original" {
		t.Fatalf("通过链接读到 %q", got)
	}
	writeFile(t, filepath.Join(link, "added.txt"), "via-link")
	if got := mustRead(t, filepath.Join(target, "added.txt")); got != "via-link" {
		t.Fatalf("通过链接写入后目标内容为 %q", got)
	}
}

func TestJunctionRemoveAllKeepsTarget(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "host", "shared")
	link := filepath.Join(root, "projection", "shared")
	writeFile(t, filepath.Join(target, "keep.txt"), "original")

	if err := createJunction(target, link); err != nil {
		t.Fatalf("createJunction: %v", err)
	}
	writeFile(t, filepath.Join(link, "added.txt"), "via-link")

	// 删链接本身：目标必须完好。
	if err := os.RemoveAll(link); err != nil {
		t.Fatalf("RemoveAll(link): %v", err)
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatalf("链接仍然存在：%v", err)
	}
	if got := mustRead(t, filepath.Join(target, "keep.txt")); got != "original" {
		t.Fatalf("目标文件被破坏：%q", got)
	}
	if got := mustRead(t, filepath.Join(target, "added.txt")); got != "via-link" {
		t.Fatalf("通过链接写入的数据丢失：%q", got)
	}

	// 删父目录（内部含链接）：不能递归进链接。
	if err := createJunction(target, link); err != nil {
		t.Fatalf("createJunction again: %v", err)
	}
	writeFile(t, filepath.Join(root, "projection", "sibling.txt"), "sibling")
	if err := os.RemoveAll(filepath.Dir(link)); err != nil {
		t.Fatalf("RemoveAll(parent): %v", err)
	}
	if got := mustRead(t, filepath.Join(target, "keep.txt")); got != "original" {
		t.Fatalf("父目录删除波及目标：%q", got)
	}
}

func TestJunctionRenameSemantics(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "host", "shared")
	link := filepath.Join(root, "projection", "shared")
	writeFile(t, filepath.Join(target, "keep.txt"), "original")
	if err := createJunction(target, link); err != nil {
		t.Fatalf("createJunction: %v", err)
	}

	// 改名保留挂载点，目标不受影响。
	renamed := filepath.Join(root, "projection", "shared-moved")
	if err := os.Rename(link, renamed); err != nil {
		t.Fatalf("rename junction: %v", err)
	}
	assertJunction(t, renamed, target)
	if got := mustRead(t, filepath.Join(renamed, "keep.txt")); got != "original" {
		t.Fatalf("改名后读不到目标内容：%q", got)
	}

	// Windows 不能用一个 rename 覆盖已存在的 junction——安装流程依赖这个前提，
	// 必须先移走旧条目。若未来系统允许覆盖，这条断言会失败，需要重新评估安装流程。
	staging := filepath.Join(root, "projection", "staging")
	writeFile(t, filepath.Join(staging, "fresh.txt"), "fresh")
	if err := os.Rename(staging, renamed); err == nil {
		t.Fatalf("rename 覆盖 junction 竟然成功；安装流程的“先移走再替换”假设需要重新验证")
	}
	if got := mustRead(t, filepath.Join(target, "keep.txt")); got != "original" {
		t.Fatalf("失败的 rename 破坏了目标：%q", got)
	}
}

func TestJunctionDangling(t *testing.T) {
	root := t.TempDir()
	missing := filepath.Join(root, "host", "missing")
	link := filepath.Join(root, "projection", "dangling")
	if err := createJunction(missing, link); err != nil {
		t.Fatalf("createJunction(dangling): %v", err)
	}
	// 悬挂链接本身仍然可识别，穿透访问必须失败。
	if info, err := os.Lstat(link); err != nil || !isLinkEntry(info, link) {
		t.Fatalf("悬挂链接 lstat err=%v info=%v", err, info)
	}
	if _, err := os.Stat(link); !os.IsNotExist(err) {
		t.Fatalf("悬挂链接 stat 期望 ENOENT，得到 %v", err)
	}
	if err := os.RemoveAll(link); err != nil {
		t.Fatalf("RemoveAll(dangling): %v", err)
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("删除悬挂链接不应创建目标：%v", err)
	}
}

func TestApplySkillLinkCreatesJunction(t *testing.T) {
	root := t.TempDir()
	store := filepath.Join(root, "store")
	account := filepath.Join(root, "projection", ".codebuddy", "skills")
	writeFile(t, filepath.Join(store, "alpha", "SKILL.md"), "# alpha")
	writeFile(t, filepath.Join(store, "beta", "SKILL.md"), "# beta")
	writeFile(t, filepath.Join(account, "own", "note.txt"), "own")

	first := applySkillLink(SkillLinkEntry{
		StoreSkillsDir: store, AccountSkillsDir: account,
		ProjectionRoot: filepath.Join(root, "projection"),
		Disabled:       []string{"beta"},
	}, "win32")
	if first.Linked != 1 || first.Unresolved == nil || len(first.Unresolved) != 1 || first.Unresolved[0] != "own" {
		t.Fatalf("首次结果不符：%+v", first)
	}
	assertJunction(t, filepath.Join(account, "alpha"), filepath.Join(store, "alpha"))
	if _, err := os.Lstat(filepath.Join(account, "beta")); !os.IsNotExist(err) {
		t.Fatalf("禁用的技能不应建链：%v", err)
	}

	second := applySkillLink(SkillLinkEntry{
		StoreSkillsDir: store, AccountSkillsDir: account,
		ProjectionRoot: filepath.Join(root, "projection"),
		Disabled:       []string{"beta"},
	}, "win32")
	// 正确链接在步骤 1 就计入 Kept，步骤 2 不重复计数（Node 会重复计数，仅诊断差异）。
	if second.Linked != 0 || second.Removed != 0 || second.Kept != 1 {
		t.Fatalf("二次结果应幂等：%+v", second)
	}

	// 取消禁用后补链；junction 删除不能伤到共享库。
	third := applySkillLink(SkillLinkEntry{
		StoreSkillsDir: store, AccountSkillsDir: account,
		ProjectionRoot: filepath.Join(root, "projection"),
	}, "win32")
	if third.Linked != 1 {
		t.Fatalf("启用后应补一条链接：%+v", third)
	}
	assertJunction(t, filepath.Join(account, "beta"), filepath.Join(store, "beta"))
}

func TestLinkDataRootsJunctionSurvivesProjectionRemoval(t *testing.T) {
	root := t.TempDir()
	projection := filepath.Join(root, "projection")
	hostHome := filepath.Join(root, "host")
	writeFile(t, filepath.Join(hostHome, "shared", "keep.txt"), "original")
	if err := os.MkdirAll(filepath.Join(projection, "shared"), 0o755); err != nil {
		t.Fatalf("mkdir projection: %v", err)
	}

	result := linkDataRoots(Request{
		ProjectionRoot: projection,
		HostHomeDir:    hostHome,
		Platform:       "win32",
		DataRoots:      []DataRootEntry{{Projection: []string{"shared"}, Host: []string{"shared"}}},
	})
	if len(result.Linked) != 1 {
		t.Fatalf("期望 linked=1，实际 %+v", result)
	}
	assertJunction(t, filepath.Join(projection, "shared"), filepath.Join(hostHome, "shared"))

	// 清理整个投影（账号删除/回收）不能带走宿主共享数据。
	if err := os.RemoveAll(projection); err != nil {
		t.Fatalf("RemoveAll(projection): %v", err)
	}
	if got := mustRead(t, filepath.Join(hostHome, "shared", "keep.txt")); got != "original" {
		t.Fatalf("投影清理破坏了共享数据：%q", got)
	}
}

func TestLinkCachesTreatsJunctionAsUnchanged(t *testing.T) {
	root := t.TempDir()
	projection := filepath.Join(root, "projection")
	hostHome := filepath.Join(root, "host")
	writeFile(t, filepath.Join(hostHome, "Library", "Caches", "shared", "keep.txt"), "cached")
	if err := os.MkdirAll(filepath.Join(projection, "Library", "Caches"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	linkPath := filepath.Join(projection, "Library", "Caches", "shared")
	if err := createJunction(filepath.Join(hostHome, "Library", "Caches", "shared"), linkPath); err != nil {
		t.Fatalf("createJunction: %v", err)
	}

	result := linkCaches(Request{
		ProjectionRoot: projection,
		HostHomeDir:    hostHome,
		Platform:       "win32",
		Caches: []CacheEntry{{
			Projection: []string{"Library", "Caches", "shared"},
			Host:       []string{"Library", "Caches", "shared"},
		}},
	})
	if len(result.Linked) != 0 || len(result.Replaced) != 0 || len(result.Adopted) != 0 || len(result.Failed) != 0 {
		t.Fatalf("已有 junction 应判 unchanged（无任何变更）：%+v", result)
	}
	assertJunction(t, linkPath, filepath.Join(hostHome, "Library", "Caches", "shared"))
}
