package nativeresources

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	sourceUploadDirName = "native-resource-sources"
	maxSourceFiles      = 256
	maxSourceBytes      = 4 * 1024 * 1024
	maxArchiveBytes     = 64 * 1024 * 1024
	sourceUploadTTL     = 24 * time.Hour
)

var uploadIDPattern = regexp.MustCompile(`^[a-f0-9]{16}$`)

// SourceImport 是一次安装源导入的结果。
type SourceImport struct {
	OK       bool     `json:"ok"`
	UploadID string   `json:"uploadId"`
	Name     string   `json:"name"`
	Files    int      `json:"files"`
	Bytes    int64    `json:"bytes"`
	Targets  []string `json:"targets,omitempty"`
}

// SourceFile 是上传或解包得到的单个文件（Path 是包内相对路径）。
type SourceFile struct {
	Path    string
	Content []byte
}

func (s *Service) sourceUploadRoot() string {
	return filepath.Join(s.aiHomeDir, "run", sourceUploadDirName)
}

// ImportSourceFiles 把浏览器选择的文件夹写入一次性上传目录，返回 uploadId。
func (s *Service) ImportSourceFiles(kind string, files []SourceFile, displayName string) (SourceImport, error) {
	if err := validateSourceKind(kind); err != nil {
		return SourceImport{}, err
	}
	normalized, total, err := normalizeSourceFiles(files)
	if err != nil {
		return SourceImport{}, err
	}
	root := s.sourceUploadRoot()
	if err := os.MkdirAll(root, 0o700); err != nil {
		return SourceImport{}, fail("native_resource_source_forbidden")
	}
	s.pruneSourceUploads(root)
	id := randomSuffix()
	dir := filepath.Join(root, id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return SourceImport{}, fail("native_resource_source_forbidden")
	}
	for _, file := range normalized {
		target := filepath.Join(dir, filepath.FromSlash(file.Path))
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			_ = os.RemoveAll(dir)
			return SourceImport{}, fail("native_resource_source_forbidden")
		}
		if err := os.WriteFile(target, file.Content, 0o600); err != nil {
			_ = os.RemoveAll(dir)
			return SourceImport{}, fail("native_resource_source_forbidden")
		}
	}
	return SourceImport{OK: true, UploadID: id, Name: strings.TrimSpace(displayName), Files: len(normalized), Bytes: total, Targets: sourceImportTargets(kind, dir)}, nil
}

// sourceImportTargets 在导入后读取插件声明的目标，让 UI 只展示兼容的 Provider / Host。
func sourceImportTargets(kind, dir string) []string {
	if strings.ToLower(strings.TrimSpace(kind)) != "plugin" {
		return nil
	}
	pkg, err := readPluginPackage(dir)
	if err != nil {
		return nil
	}
	return pluginDeclaredTargets(pkg)
}

// ImportSourceURL 下载 http(s) 归档或单文件，解包后按上传源处理。
func (s *Service) ImportSourceURL(ctx context.Context, kind, rawURL string) (SourceImport, error) {
	if err := validateSourceKind(kind); err != nil {
		return SourceImport{}, err
	}
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return SourceImport{}, fail("native_resource_source_url_invalid")
	}
	client := &http.Client{
		Timeout: 60 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return errors.New("too many redirects")
			}
			return nil
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return SourceImport{}, fail("native_resource_source_url_invalid")
	}
	resp, err := client.Do(req)
	if err != nil {
		return SourceImport{}, fail("native_resource_source_download_failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return SourceImport{}, fail("native_resource_source_download_failed")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxArchiveBytes+1))
	if err != nil || int64(len(data)) > maxArchiveBytes {
		return SourceImport{}, fail("native_resource_source_too_large")
	}
	files, err := decodeSourceArchive(data, u.Path)
	if err != nil {
		return SourceImport{}, err
	}
	name := path.Base(u.Path)
	if name == "." || name == "/" {
		name = "source"
	}
	return s.ImportSourceFiles(kind, files, name)
}

func validateSourceKind(kind string) error {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "plugin", "skill", "mcp":
		return nil
	default:
		return fail("native_resource_kind_invalid")
	}
}

func normalizeSourceFiles(files []SourceFile) ([]SourceFile, int64, error) {
	if len(files) == 0 {
		return nil, 0, fail("native_resource_source_empty")
	}
	if len(files) > maxSourceFiles {
		return nil, 0, fail("native_resource_source_limit")
	}
	out := make([]SourceFile, 0, len(files))
	seen := make(map[string]bool, len(files))
	var total int64
	for _, file := range files {
		rel, err := cleanSourcePath(file.Path)
		if err != nil {
			return nil, 0, err
		}
		if seen[rel] {
			return nil, 0, fail("native_resource_source_duplicate")
		}
		seen[rel] = true
		total += int64(len(file.Content))
		if total > maxSourceBytes {
			return nil, 0, fail("native_resource_source_limit")
		}
		out = append(out, SourceFile{Path: rel, Content: file.Content})
	}
	// 常见 GitHub 归档只有一个顶层目录；剥掉它，让 SKILL.md / package.json 落在根部。
	stripped := stripCommonSourceRoot(out)
	return stripped, total, nil
}

func cleanSourcePath(raw string) (string, error) {
	name := strings.TrimSpace(strings.ReplaceAll(raw, "\\", "/"))
	name = strings.TrimPrefix(name, "./")
	if name == "" || strings.HasPrefix(name, "/") || strings.ContainsRune(name, 0) {
		return "", fail("native_resource_source_path_invalid")
	}
	for _, segment := range strings.Split(name, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", fail("native_resource_source_path_invalid")
		}
	}
	return name, nil
}

func stripCommonSourceRoot(files []SourceFile) []SourceFile {
	if len(files) == 0 {
		return files
	}
	first := strings.SplitN(files[0].Path, "/", 2)
	if len(first) < 2 {
		return files
	}
	root := first[0]
	for _, file := range files {
		if !strings.HasPrefix(file.Path, root+"/") {
			return files
		}
	}
	out := make([]SourceFile, 0, len(files))
	for _, file := range files {
		out = append(out, SourceFile{Path: strings.TrimPrefix(file.Path, root+"/"), Content: file.Content})
	}
	return out
}

func decodeSourceArchive(data []byte, sourceName string) ([]SourceFile, error) {
	switch {
	case len(data) >= 4 && bytes.HasPrefix(data, []byte("PK\x03\x04")):
		return decodeZipSource(data)
	case len(data) >= 2 && bytes.HasPrefix(data, []byte{0x1f, 0x8b}):
		return decodeTarSource(data, true)
	case isTarArchive(data), strings.HasSuffix(strings.ToLower(sourceName), ".tar"):
		return decodeTarSource(data, false)
	default:
		base := path.Base(sourceName)
		if base == "." || base == "/" || base == "" {
			base = "source"
		}
		return []SourceFile{{Path: base, Content: data}}, nil
	}
}

func decodeZipSource(data []byte) ([]SourceFile, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fail("native_resource_source_archive_invalid")
	}
	files := make([]SourceFile, 0, len(reader.File))
	var total int64
	for _, file := range reader.File {
		if file.FileInfo().IsDir() {
			continue
		}
		if file.Mode()&os.ModeSymlink != 0 {
			return nil, fail("native_resource_source_archive_invalid")
		}
		rel, err := cleanSourcePath(file.Name)
		if err != nil {
			return nil, err
		}
		opened, err := file.Open()
		if err != nil {
			return nil, fail("native_resource_source_archive_invalid")
		}
		content, readErr := io.ReadAll(io.LimitReader(opened, maxSourceBytes+1))
		_ = opened.Close()
		if readErr != nil || int64(len(content)) > maxSourceBytes {
			return nil, fail("native_resource_source_archive_invalid")
		}
		total += int64(len(content))
		if total > maxSourceBytes || len(files) >= maxSourceFiles {
			return nil, fail("native_resource_source_limit")
		}
		files = append(files, SourceFile{Path: rel, Content: content})
	}
	if len(files) == 0 {
		return nil, fail("native_resource_source_empty")
	}
	return files, nil
}

func decodeTarSource(data []byte, gzipped bool) ([]SourceFile, error) {
	var reader io.Reader = bytes.NewReader(data)
	if gzipped {
		gz, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, fail("native_resource_source_archive_invalid")
		}
		defer gz.Close()
		reader = gz
	}
	tarReader := tar.NewReader(reader)
	files := make([]SourceFile, 0)
	var total int64
	for {
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fail("native_resource_source_archive_invalid")
		}
		if header.Typeflag == tar.TypeDir {
			continue
		}
		if header.Typeflag != tar.TypeReg {
			return nil, fail("native_resource_source_archive_invalid")
		}
		rel, err := cleanSourcePath(header.Name)
		if err != nil {
			return nil, err
		}
		content, readErr := io.ReadAll(io.LimitReader(tarReader, maxSourceBytes+1))
		if readErr != nil || int64(len(content)) > maxSourceBytes {
			return nil, fail("native_resource_source_archive_invalid")
		}
		total += int64(len(content))
		if total > maxSourceBytes || len(files) >= maxSourceFiles {
			return nil, fail("native_resource_source_limit")
		}
		files = append(files, SourceFile{Path: rel, Content: content})
	}
	if len(files) == 0 {
		return nil, fail("native_resource_source_empty")
	}
	return files, nil
}

func isTarArchive(data []byte) bool {
	if len(data) < 512 {
		return false
	}
	return string(data[257:262]) == "ustar"
}

// resolveUploadSource 把 uploadId 映射到一次性目录。
func (s *Service) resolveUploadSource(uploadID string) (string, error) {
	id := strings.TrimSpace(uploadID)
	if !uploadIDPattern.MatchString(id) {
		return "", fail("native_resource_source_invalid")
	}
	dir := filepath.Join(s.sourceUploadRoot(), id)
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return "", fail("native_resource_source_missing")
	}
	return dir, nil
}

func (s *Service) pruneSourceUploads(root string) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	now := time.Now()
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil || now.Sub(info.ModTime()) < sourceUploadTTL {
			continue
		}
		_ = os.RemoveAll(filepath.Join(root, entry.Name()))
	}
}

// singleSourceFile 把上传目录收敛为 MCP 需要的单个脚本路径。
func singleSourceFile(source string) (string, error) {
	info, err := os.Stat(source)
	if err != nil {
		return "", fail("native_resource_source_missing")
	}
	if !info.IsDir() {
		return source, nil
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		return "", fail("native_resource_source_missing")
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		names = append(names, entry.Name())
	}
	if len(names) != 1 {
		return "", fail("native_resource_source_ambiguous")
	}
	sort.Strings(names)
	return filepath.Join(source, names[0]), nil
}

// SourceInspection 是安装源预检结果（不落盘、不安装）。
type SourceInspection struct {
	OK          bool     `json:"ok"`
	Kind        string   `json:"kind"`
	ID          string   `json:"id,omitempty"`
	Description string   `json:"description,omitempty"`
	Version     string   `json:"version,omitempty"`
	Targets     []string `json:"targets,omitempty"`
}

// InspectSource 读取安装包声明，供 UI 在安装前收敛目标。
func (s *Service) InspectSource(kind, rawSource string) (SourceInspection, error) {
	if err := validateSourceKind(kind); err != nil {
		return SourceInspection{}, err
	}
	src, err := s.sourceFor(rawSource)
	if err != nil {
		return SourceInspection{}, err
	}
	normalizedKind := strings.ToLower(strings.TrimSpace(kind))
	inspection := SourceInspection{OK: true, Kind: normalizedKind}
	switch normalizedKind {
	case "plugin":
		pkg, readErr := readPluginPackage(src)
		if readErr != nil {
			return SourceInspection{}, readErr
		}
		inspection.ID = pkg.ID
		inspection.Description = packageDescription(pkg)
		inspection.Version = pkg.Version
		inspection.Targets = pluginDeclaredTargets(pkg)
	case "skill":
		pkg, readErr := readSkillPackage(src)
		if readErr != nil {
			return SourceInspection{}, readErr
		}
		inspection.ID = pkg.ID
		inspection.Description = pkg.Description
	}
	return inspection, nil
}
