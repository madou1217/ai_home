package artifactstore

import (
	"os"
	"path/filepath"
	"strings"
)

// FileLink 是"文件条目建软链"的声明：目标必须存在（不建悬挂链接），位置已存在则跳过。
// 失败不影响调用方（配置链是 best-effort）。
type FileLink struct {
	LinkPath   string `json:"linkPath"`
	TargetPath string `json:"targetPath"`
}

type FileLinkResult struct {
	Linked []string `json:"linked,omitempty"`
}

func applyFileLinks(request Request) FileLinkResult {
	result := FileLinkResult{}
	for _, entry := range request.FileLinks {
		linkPath := filepath.Clean(strings.TrimSpace(entry.LinkPath))
		targetPath := filepath.Clean(strings.TrimSpace(entry.TargetPath))
		if linkPath == "." || targetPath == "." {
			continue
		}
		// 目标必须已经存在：这些是"规范存储先有配置，再让账号投影指过来"。
		if info, err := os.Lstat(targetPath); err != nil || info == nil {
			continue
		}
		// 位置已存在（并发下别人刚建好，或调用方漏删）→ 不覆盖。
		if info, err := lstatOrNil(linkPath); err != nil || info != nil {
			continue
		}
		if err := os.Symlink(targetPath, linkPath); err == nil {
			result.Linked = append(result.Linked, linkPath)
		}
	}
	return result
}
