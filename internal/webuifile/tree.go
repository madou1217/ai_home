package webuifile

import (
	"path/filepath"
	"sort"
	"strings"
)

// 目录树默认隐藏的名字，与 Node 的 HIDDEN_NAMES 一致；其余点开头文件也隐藏。
var HiddenTreeNames = map[string]struct{}{
	".git":         {},
	"node_modules": {},
	".next":        {},
	".nuxt":        {},
	"__pycache__":  {},
	".cache":       {},
	".DS_Store":    {},
	"Thumbs.db":    {},
}

// MaxTreeEntries 是单次列目录返回的条目上限。
const MaxTreeEntries = 200

// 条目类型。
const (
	TreeEntryDirectory = "directory"
	TreeEntryFile      = "file"
)

// TreeEntry 是目录树条目的形状；目录没有 size（Size 为 nil）。
type TreeEntry struct {
	Name        string
	Type        string
	Size        *int64
	MTime       int64
	HasChildren bool
}

// TreeResult 是 /fs/tree 的响应形状。
type TreeResult struct {
	Path        string
	ProjectPath string
	Entries     []TreeEntry
	Truncated   bool
}

// Tree 对应 handleFileTreeRequest 的核心：只允许浏览已登记项目，
// 相对路径做字面与符号链接两层越界检查，条目按真实路径过滤后再裁剪。
func Tree(fs FS, registry *ProjectRoots, projectPath, relativePath string, showHidden bool) (*TreeResult, *FileError) {
	if strings.TrimSpace(projectPath) == "" {
		return nil, &FileError{Status: 400, Code: "project_path_required", Message: "必须提供项目路径"}
	}
	root, ok := registry.Authorize(projectPath)
	if !ok {
		return nil, &FileError{Status: 403, Code: "unknown_project_root", Message: "只允许浏览已登记项目内的文件"}
	}
	child, ok := ResolveProjectChild(fs, root, relativePath)
	if !ok {
		return nil, &FileError{Status: 403, Code: "path_escape", Message: "路径越界"}
	}
	info, err := fs.Stat(child.RealTarget)
	if err != nil {
		return nil, &FileError{Status: 404, Code: "not_found", Message: "路径不存在", Cause: err}
	}
	if !info.IsDir() {
		return nil, &FileError{Status: 400, Code: "not_a_directory", Message: "目标不是目录"}
	}
	rawEntries, err := fs.ReadDir(child.RealTarget)
	if err != nil {
		return nil, &FileError{Status: 403, Code: "read_denied", Message: "无法读取目录", Cause: err}
	}

	entries := make([]TreeEntry, 0, len(rawEntries))
	for _, entry := range rawEntries {
		name := entry.Name()
		if !showHidden && isHiddenTreeName(name) {
			continue
		}
		childReal, err := realPathStrict(fs, filepath.Join(child.RealTarget, name))
		if err != nil {
			continue
		}
		if !WithinRoot(child.RealRoot, childReal) {
			continue
		}
		childInfo, err := fs.Stat(childReal)
		if err != nil {
			continue
		}
		isDir := childInfo.IsDir()
		entryType := TreeEntryFile
		var size *int64
		if isDir {
			entryType = TreeEntryDirectory
		} else {
			value := childInfo.Size()
			size = &value
		}
		entries = append(entries, TreeEntry{
			Name:        name,
			Type:        entryType,
			Size:        size,
			MTime:       childInfo.ModTime().UnixMilli(),
			HasChildren: isDir,
		})
		if len(entries) >= MaxTreeEntries {
			break
		}
	}

	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].Type != entries[j].Type {
			return entries[i].Type == TreeEntryDirectory
		}
		return strings.Compare(entries[i].Name, entries[j].Name) < 0
	})

	responsePath := strings.TrimSpace(relativePath)
	if responsePath == "" {
		responsePath = "."
	}
	return &TreeResult{
		Path:        responsePath,
		ProjectPath: root,
		Entries:     entries,
		Truncated:   len(rawEntries) > MaxTreeEntries,
	}, nil
}

func isHiddenTreeName(name string) bool {
	if _, ok := HiddenTreeNames[name]; ok {
		return true
	}
	return strings.HasPrefix(name, ".")
}
