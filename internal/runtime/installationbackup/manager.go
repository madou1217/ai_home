// Package installationbackup 管理本机 AIH 运行文件的可视化备份与恢复。
//
// 备份范围刻意限定为「程序与 Web UI」：aih-server、同目录的 aih-go，以及服务器
// 实际托管的 web 目录。账号、数据库、日志与运行态不进入备份——它们体积大、含凭据，
// 且恢复它们属于另一套语义（账号导入/数据库迁移），不能混在“回滚程序”里。
package installationbackup

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	manifestName    = "manifest.json"
	serverFileName  = "aih-server"
	cliFileName     = "aih-go"
	webArchiveName  = "web.tar.gz"
	defaultMax      = 5
	manifestVersion = 1
)

// FileInfo 描述一个被备份的二进制。
type FileInfo struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// WebInfo 描述 web 目录的归档。
type WebInfo struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Files  int    `json:"files"`
	Bytes  int64  `json:"bytes"`
}

// Entry 是一份备份的清单。
type Entry struct {
	Version   int       `json:"version"`
	ID        string    `json:"id"`
	CreatedAt string    `json:"createdAt"`
	Label     string    `json:"label,omitempty"`
	Server    *FileInfo `json:"server,omitempty"`
	CLI       *FileInfo `json:"cli,omitempty"`
	Web       *WebInfo  `json:"web,omitempty"`
}

// Options 配置备份管理器。
type Options struct {
	AIHomeDir    string
	ServerBinary string
	CLIBinary    string
	WebDir       string
	MaxEntries   int
	Now          func() time.Time
}

// Manager 负责创建、列出、恢复与删除运行文件备份。
type Manager struct {
	aiHomeDir string
	rootDir   string
	server    string
	cli       string
	webDir    string
	max       int
	now       func() time.Time
}

// New 创建管理器；AIHomeDir 为空时失败关闭。
func New(options Options) (*Manager, error) {
	aiHomeDir := strings.TrimSpace(options.AIHomeDir)
	if aiHomeDir == "" {
		return nil, errors.New("installation_backup_home_missing")
	}
	maxEntries := options.MaxEntries
	if maxEntries <= 0 {
		maxEntries = defaultMax
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Manager{
		aiHomeDir: aiHomeDir,
		rootDir:   filepath.Join(aiHomeDir, "run", "installation-backups"),
		server:    strings.TrimSpace(options.ServerBinary),
		cli:       strings.TrimSpace(options.CLIBinary),
		webDir:    strings.TrimSpace(options.WebDir),
		max:       maxEntries,
		now:       now,
	}, nil
}

// RootDir 返回备份根目录（诊断用）。
func (manager *Manager) RootDir() string { return manager.rootDir }

// List 返回按创建时间倒序的有效备份。
func (manager *Manager) List() ([]Entry, error) {
	if manager == nil {
		return nil, errors.New("installation_backup_unavailable")
	}
	names, err := os.ReadDir(manager.rootDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []Entry{}, nil
		}
		return nil, err
	}
	entries := make([]Entry, 0, len(names))
	for _, name := range names {
		if !name.IsDir() || !validID(name.Name()) {
			continue
		}
		entry, loadErr := manager.load(name.Name())
		if loadErr != nil {
			continue
		}
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].CreatedAt == entries[j].CreatedAt {
			return entries[i].ID > entries[j].ID
		}
		return entries[i].CreatedAt > entries[j].CreatedAt
	})
	return entries, nil
}

// Current 返回当前运行文件的指纹，供界面标记“当前版本”。
func (manager *Manager) Current() Entry {
	current := Entry{Version: manifestVersion}
	if manager == nil {
		return current
	}
	if info, err := describeFile(manager.server); err == nil {
		current.Server = &info
	}
	if info, err := describeFile(manager.cli); err == nil {
		current.CLI = &info
	}
	if info, err := describeWeb(manager.webDir); err == nil {
		current.Web = &info
	}
	return current
}

// Create 创建一份新备份，并裁剪超出上限的旧备份。
func (manager *Manager) Create(label string) (Entry, error) {
	if manager == nil {
		return Entry{}, errors.New("installation_backup_unavailable")
	}
	if manager.server == "" {
		return Entry{}, errors.New("installation_backup_server_missing")
	}
	if info, err := os.Stat(manager.server); err != nil || info.IsDir() {
		return Entry{}, fmt.Errorf("installation_backup_server_unreadable: %w", err)
	}
	if err := os.MkdirAll(manager.rootDir, 0o700); err != nil {
		return Entry{}, err
	}
	id := manager.nextID()
	dir := filepath.Join(manager.rootDir, id)
	if err := os.Mkdir(dir, 0o700); err != nil {
		return Entry{}, err
	}
	entry := Entry{Version: manifestVersion, ID: id, CreatedAt: manager.now().UTC().Format(time.RFC3339), Label: strings.TrimSpace(label)}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.RemoveAll(dir)
		}
	}()

	serverInfo, err := copyWithHash(manager.server, filepath.Join(dir, serverFileName))
	if err != nil {
		return Entry{}, fmt.Errorf("installation_backup_server_copy: %w", err)
	}
	entry.Server = &serverInfo
	if manager.cli != "" {
		if info, statErr := os.Stat(manager.cli); statErr == nil && !info.IsDir() {
			cliInfo, copyErr := copyWithHash(manager.cli, filepath.Join(dir, cliFileName))
			if copyErr != nil {
				return Entry{}, fmt.Errorf("installation_backup_cli_copy: %w", copyErr)
			}
			entry.CLI = &cliInfo
		}
	}
	if manager.webDir != "" {
		if info, statErr := os.Stat(manager.webDir); statErr == nil && info.IsDir() {
			webInfo, archiveErr := archiveWeb(manager.webDir, filepath.Join(dir, webArchiveName))
			if archiveErr != nil {
				return Entry{}, fmt.Errorf("installation_backup_web_archive: %w", archiveErr)
			}
			entry.Web = &webInfo
		}
	}
	if err := manager.writeManifest(dir, entry); err != nil {
		return Entry{}, err
	}
	cleanup = false
	manager.prune()
	return entry, nil
}

// Restore 把指定备份写回运行位置。调用方负责随后重启服务。
func (manager *Manager) Restore(id string) (Entry, error) {
	if manager == nil {
		return Entry{}, errors.New("installation_backup_unavailable")
	}
	if !validID(id) {
		return Entry{}, errors.New("installation_backup_invalid_id")
	}
	entry, err := manager.load(id)
	if err != nil {
		return Entry{}, err
	}
	dir := filepath.Join(manager.rootDir, id)
	if entry.Server != nil {
		if err := verifyFile(filepath.Join(dir, serverFileName), entry.Server.SHA256); err != nil {
			return Entry{}, err
		}
		if err := replaceFile(filepath.Join(dir, serverFileName), manager.server); err != nil {
			return Entry{}, fmt.Errorf("installation_backup_server_restore: %w", err)
		}
	}
	if entry.CLI != nil {
		if err := verifyFile(filepath.Join(dir, cliFileName), entry.CLI.SHA256); err != nil {
			return Entry{}, err
		}
		if err := replaceFile(filepath.Join(dir, cliFileName), manager.cli); err != nil {
			return Entry{}, fmt.Errorf("installation_backup_cli_restore: %w", err)
		}
	}
	if entry.Web != nil {
		archive := filepath.Join(dir, webArchiveName)
		if err := verifyFile(archive, entry.Web.SHA256); err != nil {
			return Entry{}, err
		}
		if err := restoreWeb(archive, manager.webDir, entry.ID); err != nil {
			return Entry{}, fmt.Errorf("installation_backup_web_restore: %w", err)
		}
	}
	return entry, nil
}

// Delete 删除一份备份。
func (manager *Manager) Delete(id string) error {
	if manager == nil {
		return errors.New("installation_backup_unavailable")
	}
	if !validID(id) {
		return errors.New("installation_backup_invalid_id")
	}
	return os.RemoveAll(filepath.Join(manager.rootDir, id))
}

func (manager *Manager) load(id string) (Entry, error) {
	raw, err := os.ReadFile(filepath.Join(manager.rootDir, id, manifestName))
	if err != nil {
		return Entry{}, err
	}
	var entry Entry
	if json.Unmarshal(raw, &entry) != nil || entry.Version != manifestVersion || entry.ID != id {
		return Entry{}, errors.New("installation_backup_manifest_invalid")
	}
	return entry, nil
}

func (manager *Manager) writeManifest(dir string, entry Entry) error {
	payload, err := json.MarshalIndent(entry, "", "  ")
	if err != nil {
		return err
	}
	temporary := filepath.Join(dir, manifestName+".tmp")
	if err := os.WriteFile(temporary, payload, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, filepath.Join(dir, manifestName))
}

func (manager *Manager) nextID() string {
	base := manager.now().UTC().Format("20060102T150405Z")
	id := base
	for index := 2; ; index++ {
		if _, err := os.Stat(filepath.Join(manager.rootDir, id)); errors.Is(err, os.ErrNotExist) {
			return id
		}
		id = fmt.Sprintf("%s-%d", base, index)
	}
}

func (manager *Manager) prune() {
	entries, err := manager.List()
	if err != nil {
		return
	}
	for index := manager.max; index < len(entries); index++ {
		_ = os.RemoveAll(filepath.Join(manager.rootDir, entries[index].ID))
	}
}

func validID(id string) bool {
	if id == "" || len(id) > 64 || strings.ContainsAny(id, `/\`) || id == "." || id == ".." {
		return false
	}
	for _, char := range id {
		if (char >= '0' && char <= '9') || (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char == '-' || char == '_' {
			continue
		}
		return false
	}
	return true
}

func describeFile(path string) (FileInfo, error) {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return FileInfo{}, errors.New("installation_backup_file_unreadable")
	}
	digest, err := hashFile(path)
	if err != nil {
		return FileInfo{}, err
	}
	return FileInfo{Path: path, SHA256: digest, Size: info.Size()}, nil
}

func describeWeb(dir string) (WebInfo, error) {
	if dir == "" {
		return WebInfo{}, os.ErrNotExist
	}
	files, bytes, err := countWeb(dir)
	if err != nil {
		return WebInfo{}, err
	}
	digest, err := hashWebArchive(dir)
	if err != nil {
		return WebInfo{}, err
	}
	return WebInfo{Path: dir, SHA256: digest, Files: files, Bytes: bytes}, nil
}

func hashFile(path string) (string, error) {
	handle, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer handle.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, handle); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func verifyFile(path, expected string) error {
	actual, err := hashFile(path)
	if err != nil {
		return err
	}
	if !strings.EqualFold(actual, expected) {
		return errors.New("installation_backup_checksum_mismatch")
	}
	return nil
}

func copyWithHash(source, destination string) (FileInfo, error) {
	in, err := os.Open(source)
	if err != nil {
		return FileInfo{}, err
	}
	defer in.Close()
	out, err := os.OpenFile(destination, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o700)
	if err != nil {
		return FileInfo{}, err
	}
	digest := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(out, digest), in)
	closeErr := out.Close()
	if copyErr != nil {
		return FileInfo{}, copyErr
	}
	if closeErr != nil {
		return FileInfo{}, closeErr
	}
	return FileInfo{Path: source, SHA256: hex.EncodeToString(digest.Sum(nil)), Size: written}, nil
}

// replaceFile 用备份文件原子替换运行文件。
func replaceFile(source, destination string) error {
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	temporary := destination + ".installation-backup.tmp"
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(temporary, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(temporary)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Chmod(temporary, 0o755); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return os.Rename(temporary, destination)
}

// archiveWeb 生成 web 目录归档，名称按字典序以保证相同内容得到相同摘要。
func archiveWeb(dir, destination string) (WebInfo, error) {
	files, total, err := webFiles(dir)
	if err != nil {
		return WebInfo{}, err
	}
	temporary := destination + ".tmp"
	handle, err := os.OpenFile(temporary, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return WebInfo{}, err
	}
	digest := sha256.New()
	gzipWriter := gzip.NewWriter(io.MultiWriter(handle, digest))
	tarWriter := tar.NewWriter(gzipWriter)
	for _, relative := range files {
		full := filepath.Join(dir, filepath.FromSlash(relative))
		info, statErr := os.Stat(full)
		if statErr != nil || !info.Mode().IsRegular() {
			continue
		}
		header, headerErr := tar.FileInfoHeader(info, "")
		if headerErr != nil {
			tarWriter.Close()
			gzipWriter.Close()
			handle.Close()
			_ = os.Remove(temporary)
			return WebInfo{}, headerErr
		}
		header.Name = relative
		// 摘要只取决于文件集合与内容：mtime/uid 等易变字段清零，恢复后仍能匹配“当前版本”。
		header.ModTime = time.Time{}
		header.AccessTime = time.Time{}
		header.ChangeTime = time.Time{}
		header.Uid = 0
		header.Gid = 0
		header.Uname = ""
		header.Gname = ""
		if err := tarWriter.WriteHeader(header); err != nil {
			tarWriter.Close()
			gzipWriter.Close()
			handle.Close()
			_ = os.Remove(temporary)
			return WebInfo{}, err
		}
		file, openErr := os.Open(full)
		if openErr != nil {
			tarWriter.Close()
			gzipWriter.Close()
			handle.Close()
			_ = os.Remove(temporary)
			return WebInfo{}, openErr
		}
		_, copyErr := io.Copy(tarWriter, file)
		file.Close()
		if copyErr != nil {
			tarWriter.Close()
			gzipWriter.Close()
			handle.Close()
			_ = os.Remove(temporary)
			return WebInfo{}, copyErr
		}
	}
	if err := tarWriter.Close(); err != nil {
		gzipWriter.Close()
		handle.Close()
		_ = os.Remove(temporary)
		return WebInfo{}, err
	}
	if err := gzipWriter.Close(); err != nil {
		handle.Close()
		_ = os.Remove(temporary)
		return WebInfo{}, err
	}
	if err := handle.Close(); err != nil {
		_ = os.Remove(temporary)
		return WebInfo{}, err
	}
	if err := os.Rename(temporary, destination); err != nil {
		_ = os.Remove(temporary)
		return WebInfo{}, err
	}
	return WebInfo{Path: dir, SHA256: hex.EncodeToString(digest.Sum(nil)), Files: len(files), Bytes: total}, nil
}

func hashWebArchive(dir string) (string, error) {
	temporary, err := os.CreateTemp("", "aih-web-hash-*.tar.gz")
	if err != nil {
		return "", err
	}
	name := temporary.Name()
	temporary.Close()
	defer os.Remove(name)
	info, err := archiveWeb(dir, name)
	if err != nil {
		return "", err
	}
	return info.SHA256, nil
}

func webFiles(dir string) ([]string, int64, error) {
	files := make([]string, 0, 256)
	var total int64
	err := filepath.Walk(dir, func(full string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if full == dir {
			return nil
		}
		relative, relErr := filepath.Rel(dir, full)
		if relErr != nil {
			return relErr
		}
		relative = filepath.ToSlash(relative)
		if strings.HasPrefix(relative, ".") || strings.Contains(relative, "/.") {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		files = append(files, relative)
		total += info.Size()
		return nil
	})
	if err != nil {
		return nil, 0, err
	}
	sort.Strings(files)
	return files, total, nil
}

func countWeb(dir string) (int, int64, error) {
	if _, err := os.Stat(dir); err != nil {
		return 0, 0, err
	}
	files, total, err := webFiles(dir)
	if err != nil {
		return 0, 0, err
	}
	return len(files), total, nil
}

// restoreWeb 解包到临时目录后再整体换入，失败时保留原目录。
func restoreWeb(archive, webDir, id string) error {
	if strings.TrimSpace(webDir) == "" {
		return errors.New("installation_backup_web_target_missing")
	}
	staging := webDir + ".restore-" + id
	if err := os.RemoveAll(staging); err != nil {
		return err
	}
	if err := extractWeb(archive, staging); err != nil {
		_ = os.RemoveAll(staging)
		return err
	}
	previous := webDir + ".previous-" + id
	_ = os.RemoveAll(previous)
	hadPrevious := false
	if _, err := os.Stat(webDir); err == nil {
		if err := os.Rename(webDir, previous); err != nil {
			_ = os.RemoveAll(staging)
			return err
		}
		hadPrevious = true
	}
	if err := os.Rename(staging, webDir); err != nil {
		if hadPrevious {
			_ = os.Rename(previous, webDir)
		}
		_ = os.RemoveAll(staging)
		return err
	}
	if hadPrevious {
		_ = os.RemoveAll(previous)
	}
	return nil
}

func extractWeb(archive, destination string) error {
	file, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer file.Close()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer gzipReader.Close()
	reader := tar.NewReader(gzipReader)
	for {
		header, nextErr := reader.Next()
		if errors.Is(nextErr, io.EOF) {
			return nil
		}
		if nextErr != nil {
			return nextErr
		}
		name := path.Clean(strings.TrimSpace(header.Name))
		if name == "." || name == "" || strings.HasPrefix(name, "../") || strings.HasPrefix(name, "/") {
			return errors.New("installation_backup_web_archive_invalid")
		}
		target := filepath.Join(destination, filepath.FromSlash(name))
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			out, createErr := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
			if createErr != nil {
				return createErr
			}
			if _, copyErr := io.Copy(out, reader); copyErr != nil {
				out.Close()
				return copyErr
			}
			if closeErr := out.Close(); closeErr != nil {
				return closeErr
			}
		default:
			// 只恢复普通文件与目录；符号链接等不进入 Web UI 产物。
		}
	}
}
