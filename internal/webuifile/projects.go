package webuifile

import (
	"path/filepath"
	"strings"
)

// ProjectRoots 是 WebUI 文件接口的项目根登记表。
//
// 对应 Node 的 resolveAuthorizedProjectRoot：请求里的 projectPath 必须与服务端
// 已登记项目的路径逐字相等，而不是"在某个项目下面"。登记表本身由项目快照提供，
// 快照抓取属于另一个切片，这里只消费它的结果。
type ProjectRoots struct {
	roots map[string]struct{}
}

// NewProjectRoots 从已登记项目路径构造登记表；非绝对路径直接丢弃。
func NewProjectRoots(paths []string) *ProjectRoots {
	roots := make(map[string]struct{}, len(paths))
	for _, value := range paths {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || !filepath.IsAbs(trimmed) {
			continue
		}
		roots[filepath.Clean(trimmed)] = struct{}{}
	}
	return &ProjectRoots{roots: roots}
}

// Authorize 返回登记表内的规范路径；未登记返回 false。
func (r *ProjectRoots) Authorize(requested string) (string, bool) {
	candidate := strings.TrimSpace(requested)
	if candidate == "" || !filepath.IsAbs(candidate) {
		return "", false
	}
	resolved := filepath.Clean(candidate)
	if r == nil {
		return "", false
	}
	if _, ok := r.roots[resolved]; !ok {
		return "", false
	}
	return resolved, true
}

// ProjectChild 是项目内子路径的解析结果，四个路径分别对应 Node 的
// root / realRoot / target / realTarget。
type ProjectChild struct {
	Root       string
	RealRoot   string
	Target     string
	RealTarget string
}

// ResolveProjectChild 对应 resolveProjectChild：相对路径先做字面越界检查，
// 再对根与目标求 realpath 做符号链接越界检查。任一 realpath 失败即拒绝，
// 与 Node 的 try/catch 返回 null 一致。
func ResolveProjectChild(fs FS, projectRoot, relativePath string) (ProjectChild, bool) {
	root, err := absPath(strings.TrimSpace(projectRoot))
	if err != nil {
		return ProjectChild{}, false
	}
	relative := strings.TrimSpace(relativePath)
	candidate := root
	if relative != "" {
		if filepath.IsAbs(relative) {
			candidate = filepath.Clean(relative)
		} else {
			candidate = filepath.Join(root, relative)
		}
	}
	if !WithinRoot(root, candidate) {
		return ProjectChild{}, false
	}
	realRoot, err := realPathStrict(fs, root)
	if err != nil {
		return ProjectChild{}, false
	}
	realTarget, err := realPathStrict(fs, candidate)
	if err != nil {
		return ProjectChild{}, false
	}
	if !WithinRoot(realRoot, realTarget) {
		return ProjectChild{}, false
	}
	return ProjectChild{Root: root, RealRoot: realRoot, Target: candidate, RealTarget: realTarget}, true
}
