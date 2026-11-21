package artifactstore

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// linkDataRoots 把桌面 App 的数据根（会话/数据库/设置）链接到宿主那一份。
//
// 与可再生的缓存不同，投影里已有的真实数据不能丢：
//   - 投影里没有、或只是空目录 → 建链接；
//   - 宿主没有、投影里有 → 整个移给宿主（谈不上合并）再建链接；
//   - 两边都有真实数据 → 不合并、不丢弃，返回 unresolved 由调用方拒绝启动。
func linkDataRoots(request Request) *DataRootResult {
	result := &DataRootResult{}
	projectionRoot := strings.TrimSpace(request.ProjectionRoot)
	hostHomeDir := strings.TrimSpace(request.HostHomeDir)
	if projectionRoot == "" || hostHomeDir == "" || sameAbsolutePath(projectionRoot, hostHomeDir) {
		return result
	}
	platform := normalizePlatform(request.Platform)
	for _, entry := range request.DataRoots {
		relative := filepath.Join(entry.Projection...)
		outcome, err := linkDataRoot(projectionRoot, hostHomeDir, entry, platform)
		if err != nil {
			result.Failed = append(result.Failed, CacheFailure{Path: relative, Error: err.Error()})
			continue
		}
		switch outcome {
		case "linked":
			result.Linked = append(result.Linked, relative)
		case "adopted":
			result.Adopted = append(result.Adopted, relative)
		case "unchanged":
			result.Unchanged = append(result.Unchanged, relative)
		case "unresolved":
			result.Unresolved = append(result.Unresolved, relative)
		case "skipped":
			result.Skipped = append(result.Skipped, relative)
		}
	}
	return result
}

func linkDataRoot(projectionRoot, hostHomeDir string, entry DataRootEntry, platform string) (string, error) {
	projectionPath := filepath.Join(projectionRoot, filepath.Join(entry.Projection...))
	hostTarget := filepath.Join(hostHomeDir, filepath.Join(entry.Host...))

	info, err := os.Lstat(projectionPath)
	if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	if isLinkEntry(info, projectionPath) {
		target, err := os.Readlink(projectionPath)
		if err != nil {
			return "", err
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(projectionPath), target)
		}
		if sameAbsolutePath(target, hostTarget) {
			return "unchanged", nil
		}
		return "unresolved", nil
	}

	hostInfo, hostErr := os.Lstat(hostTarget)
	if hostErr != nil && !os.IsNotExist(hostErr) {
		return "", hostErr
	}
	if info != nil && !info.IsDir() && !info.Mode().IsRegular() {
		return "unresolved", nil
	}

	hasData := false
	if info != nil {
		if info.Mode().IsRegular() {
			hasData = true
		} else if info.IsDir() {
			children, err := os.ReadDir(projectionPath)
			if err != nil {
				return "", err
			}
			hasData = len(children) > 0
		}
	}

	outcome := "linked"
	if hasData {
		if hostInfo != nil {
			return "unresolved", nil
		}
		if err := os.MkdirAll(filepath.Dir(hostTarget), 0o755); err != nil {
			return "", err
		}
		if err := os.Rename(projectionPath, hostTarget); err != nil {
			return "", err
		}
		outcome = "adopted"
	} else {
		if info != nil {
			// 只在空目录/文件时删除；有内容的分支已经走 hasData。
			if err := os.Remove(projectionPath); err != nil {
				return "", err
			}
		}
		// 投影与宿主都没有：不在宿主凭空建目录。
		if hostInfo == nil {
			return "skipped", nil
		}
	}

	if err := os.MkdirAll(filepath.Dir(projectionPath), 0o755); err != nil {
		return "", err
	}
	hostStat, err := os.Stat(hostTarget)
	if err != nil {
		return "", err
	}
	if err := createDataRootLink(hostTarget, projectionPath, hostStat.IsDir(), platform); err != nil {
		return "", err
	}
	return outcome, nil
}

func createDataRootLink(target, link string, isDir bool, platform string) error {
	if isWindowsPlatform(platform) && isDir {
		// 目录用 junction：与 Node 的 symlinkSync(..., 'junction') 等价，且不需要额外权限。
		if err := createJunction(target, link); err == nil {
			return nil
		}
	}
	return os.Symlink(target, link)
}

// dedupeSharedHostFiles 把与宿主同版本的应用解压内容逐文件替换成指向宿主的硬链接。
// 每个账号仍有自己的目录树（应用升级各自重新解压互不干扰），只是同版本文件只存一份。
func dedupeSharedHostFiles(request Request) *DedupeResult {
	result := &DedupeResult{}
	projectionRoot := strings.TrimSpace(request.ProjectionRoot)
	hostHomeDir := strings.TrimSpace(request.HostHomeDir)
	if projectionRoot == "" || hostHomeDir == "" {
		return result
	}
	for _, entry := range request.Dedupe {
		relative := filepath.Join(entry.Projection...)
		accountDir := filepath.Join(projectionRoot, filepath.Join(entry.Projection...))
		hostDir := filepath.Join(hostHomeDir, filepath.Join(entry.Host...))
		stampFile := strings.TrimSpace(entry.StampFile)
		accountStamp := readStampFile(filepath.Join(accountDir, stampFile))
		hostStamp := readStampFile(filepath.Join(hostDir, stampFile))
		// 版本不同（或任一侧未解压完成）时不碰：应用会在下次启动时自行重新解压。
		if accountStamp == "" || accountStamp != hostStamp {
			result.Skipped = append(result.Skipped, relative)
			continue
		}
		dedupeTree(accountDir, hostDir, result)
	}
	return result
}

func dedupeTree(accountDir, hostDir string, result *DedupeResult) {
	entries, err := os.ReadDir(accountDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		accountPath := filepath.Join(accountDir, entry.Name())
		hostPath := filepath.Join(hostDir, entry.Name())
		if entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		if entry.IsDir() {
			dedupeTree(accountPath, hostPath, result)
			continue
		}
		if !entry.Type().IsRegular() {
			continue
		}
		if err := dedupeFile(accountPath, hostPath, result); err != nil {
			result.Failed++
		}
	}
}

func dedupeFile(accountPath, hostPath string, result *DedupeResult) error {
	accountInfo, err := os.Lstat(accountPath)
	if err != nil {
		return err
	}
	hostInfo, err := os.Lstat(hostPath)
	if err != nil || !hostInfo.Mode().IsRegular() || hostInfo.Size() != accountInfo.Size() {
		return nil
	}
	if os.SameFile(accountInfo, hostInfo) {
		result.AlreadyShared++
		return nil
	}
	accountDigest, err := digestFile(accountPath)
	if err != nil {
		return err
	}
	hostDigest, err := digestFile(hostPath)
	if err != nil {
		return err
	}
	if accountDigest != hostDigest {
		return nil
	}
	tempPath := accountPath + ".aih-dedupe-" + strconv.Itoa(os.Getpid())
	if err := os.Link(hostPath, tempPath); err != nil {
		return err
	}
	if err := os.Rename(tempPath, accountPath); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	result.Linked++
	result.Bytes += accountInfo.Size()
	return nil
}

func readStampFile(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

func digestFile(path string) (string, error) {
	handle, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer handle.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, handle); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
