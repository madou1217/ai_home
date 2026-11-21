package artifactstore

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// HardlinkRepair 是"未版本化 shim 应硬链到某个版本化二进制"的声明。
// 只在 Windows 上生效（与 Node 原实现一致）；失败一律 best-effort，不影响解析结果。
type HardlinkRepair struct {
	ShimPath   string `json:"shimPath"`
	TargetPath string `json:"targetPath"`
}

type HardlinkRepairResult struct {
	Repaired bool   `json:"repaired,omitempty"`
	Failed   string `json:"failed,omitempty"`
}

func applyHardlinkRepairs(request Request) []HardlinkRepairResult {
	results := make([]HardlinkRepairResult, 0, len(request.HardlinkRepairs))
	for _, entry := range request.HardlinkRepairs {
		results = append(results, applyHardlinkRepair(entry))
	}
	return results
}

func applyHardlinkRepair(entry HardlinkRepair) HardlinkRepairResult {
	result := HardlinkRepairResult{}
	if runtime.GOOS != "windows" {
		return result
	}
	shim := filepath.Clean(strings.TrimSpace(entry.ShimPath))
	target := filepath.Clean(strings.TrimSpace(entry.TargetPath))
	if shim == "." || target == "." || shim == target {
		return result
	}
	// 已有可执行 shim 且与目标同一文件（同一 File ID）→ 不动。
	if shimInfo, err := os.Stat(shim); err == nil && isExecutableShim(shimInfo) {
		targetInfo, targetErr := os.Stat(target)
		if targetErr != nil {
			return result
		}
		if os.SameFile(shimInfo, targetInfo) {
			return result
		}
	}
	// 与 Node 的 rmSync(force) 同口径：删不掉（非空目录、权限）就放弃，不硬链。
	if err := os.Remove(shim); err != nil && !os.IsNotExist(err) {
		return result
	}
	if err := os.Link(target, shim); err != nil {
		result.Failed = errnoName(err)
		return result
	}
	result.Repaired = true
	return result
}

// isExecutableShim 对齐 Node 的 isExecutableFile：普通文件且非空；POSIX 还要求可执行位。
func isExecutableShim(info os.FileInfo) bool {
	if !info.Mode().IsRegular() || info.Size() <= 0 {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return info.Mode()&0o111 != 0
}
