package deletionprojection

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

type projectionEntryKind uint8

const (
	projectionEntryUnknown projectionEntryKind = iota
	projectionEntryPrivate
	projectionEntryContainer
	projectionEntryResource
)

type projectionEntry struct {
	kind        projectionEntryKind
	destination []string
}

type privateProjectionPath struct {
	segments []string
	subtree  bool
	backups  bool
}

func (preparer *Preparer) reconcileResources(
	ctx context.Context,
	account accountcore.Account,
	root projectionRoot,
) error {
	if err := assertPlainDirectory(root.path); err != nil {
		return err
	}
	entries, err := os.ReadDir(root.path)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := preparer.reconcileProjectionEntry(
			ctx,
			account,
			root,
			[]string{entry.Name()},
		); err != nil {
			return err
		}
	}
	return nil
}

func (preparer *Preparer) reconcileProjectionEntry(
	ctx context.Context,
	account accountcore.Account,
	root projectionRoot,
	relative []string,
) error {
	classification := classifyProjectionEntry(account.ProviderID(), root.kind, relative)
	sourcePath := filepath.Join(append([]string{root.path}, relative...)...)
	info, err := os.Lstat(sourcePath)
	if err != nil {
		return err
	}

	switch classification.kind {
	case projectionEntryPrivate:
		return nil
	case projectionEntryContainer:
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("投影容器形态不受信任")
		}
		entries, err := os.ReadDir(sourcePath)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			next := append(append([]string(nil), relative...), entry.Name())
			if err := preparer.reconcileProjectionEntry(
				ctx,
				account,
				root,
				next,
			); err != nil {
				return err
			}
		}
		return nil
	case projectionEntryResource:
		destinationRoot := filepath.Join(preparer.hostHomeDir, "."+account.ProviderID())
		if err := ensureSafeDirectory(preparer.hostHomeDir, []string{"." + account.ProviderID()}); err != nil {
			return err
		}
		destinationPath := filepath.Join(
			append([]string{destinationRoot}, classification.destination...)...,
		)
		conflictPath := filepath.Join(
			append(
				[]string{
					destinationRoot,
					".aih-migration-conflicts",
					account.Ref().String(),
				},
				classification.destination...,
			)...,
		)
		return migrateResource(ctx, destinationRoot, sourcePath, destinationPath, conflictPath)
	default:
		return fmt.Errorf("投影包含未注册的 Provider 资源")
	}
}

func classifyProjectionEntry(
	providerID string,
	kind projectionKind,
	relative []string,
) projectionEntry {
	if kind == projectionKindCodexDesktop {
		if providerID != providerCodex {
			return projectionEntry{kind: projectionEntryUnknown}
		}
		if classifyPrivatePath(relative, codexDesktopPrivatePaths()) != projectionEntryUnknown {
			return projectionEntry{kind: classifyPrivatePath(relative, codexDesktopPrivatePaths())}
		}
		return projectionEntry{
			kind:        projectionEntryResource,
			destination: append([]string(nil), relative...),
		}
	}

	var mappingRoot string
	var privatePaths []privateProjectionPath
	switch providerID {
	case providerCodex:
		mappingRoot = ".codex"
		privatePaths = codexAccountPrivatePaths()
	case providerClaude:
		mappingRoot = ".claude"
		privatePaths = claudeAccountPrivatePaths()
	default:
		return projectionEntry{kind: projectionEntryUnknown}
	}
	if privateKind := classifyPrivatePath(relative, privatePaths); privateKind != projectionEntryUnknown {
		return projectionEntry{kind: privateKind}
	}
	if len(relative) == 1 && relative[0] == mappingRoot {
		return projectionEntry{kind: projectionEntryContainer}
	}
	if len(relative) > 1 && relative[0] == mappingRoot {
		return projectionEntry{
			kind:        projectionEntryResource,
			destination: append([]string(nil), relative[1:]...),
		}
	}
	return projectionEntry{kind: projectionEntryUnknown}
}

func classifyPrivatePath(
	candidate []string,
	paths []privateProjectionPath,
) projectionEntryKind {
	for _, privatePath := range paths {
		if privatePath.subtree && hasSegmentPrefix(candidate, privatePath.segments) {
			return projectionEntryPrivate
		}
		if len(candidate) == len(privatePath.segments) &&
			segmentsEqual(candidate[:len(candidate)-1], privatePath.segments[:len(privatePath.segments)-1]) {
			actualName := candidate[len(candidate)-1]
			expectedName := privatePath.segments[len(privatePath.segments)-1]
			if actualName == expectedName ||
				(privatePath.backups && strings.HasPrefix(actualName, expectedName+".")) {
				return projectionEntryPrivate
			}
		}
		if len(candidate) < len(privatePath.segments) && hasSegmentPrefix(privatePath.segments, candidate) {
			return projectionEntryContainer
		}
	}
	return projectionEntryUnknown
}

func codexAccountPrivatePaths() []privateProjectionPath {
	return []privateProjectionPath{
		{segments: []string{".codex", "auth.json"}, backups: true},
		{segments: []string{".codex", "config.toml"}, backups: true},
		{segments: []string{".codex", "tmp"}, subtree: true},
		{segments: []string{"Library", "Keychains"}, subtree: true},
	}
}

func codexDesktopPrivatePaths() []privateProjectionPath {
	return []privateProjectionPath{
		{segments: []string{"auth.json"}, backups: true},
		{segments: []string{"config.toml"}, backups: true},
		{segments: []string{"tmp"}, subtree: true},
	}
}

func claudeAccountPrivatePaths() []privateProjectionPath {
	return []privateProjectionPath{
		{segments: []string{".claude", ".credentials.json"}, backups: true},
		{segments: []string{"Library", "Keychains"}, subtree: true},
	}
}

func hasSegmentPrefix(value []string, prefix []string) bool {
	return len(prefix) <= len(value) && segmentsEqual(value[:len(prefix)], prefix)
}

func segmentsEqual(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func migrateResource(
	ctx context.Context,
	destinationRoot string,
	sourcePath string,
	destinationPath string,
	conflictPath string,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	sourceInfo, err := os.Lstat(sourcePath)
	if err != nil {
		return err
	}
	if sourceInfo.Mode()&os.ModeSymlink != 0 {
		return assertManagedResourceLink(destinationRoot, sourcePath, destinationPath)
	}
	if sourceInfo.IsDir() {
		return migrateResourceDirectory(
			ctx,
			destinationRoot,
			sourcePath,
			destinationPath,
			conflictPath,
		)
	}
	if !sourceInfo.Mode().IsRegular() {
		return fmt.Errorf("Provider 资源不是普通文件或目录")
	}
	return migrateResourceFile(destinationRoot, sourcePath, destinationPath, conflictPath)
}

func migrateResourceDirectory(
	ctx context.Context,
	destinationRoot string,
	sourcePath string,
	destinationPath string,
	conflictPath string,
) error {
	destinationInfo, err := os.Lstat(destinationPath)
	if err == nil && (!destinationInfo.IsDir() || destinationInfo.Mode()&os.ModeSymlink != 0) {
		return fmt.Errorf("Provider 资源目录与原生路径类型冲突")
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := ensureSafeAbsoluteDirectory(destinationRoot, destinationPath); err != nil {
		return err
	}
	entries, err := os.ReadDir(sourcePath)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := migrateResource(
			ctx,
			destinationRoot,
			filepath.Join(sourcePath, entry.Name()),
			filepath.Join(destinationPath, entry.Name()),
			filepath.Join(conflictPath, entry.Name()),
		); err != nil {
			return err
		}
	}
	remaining, err := os.ReadDir(sourcePath)
	if err != nil {
		return err
	}
	if len(remaining) == 0 {
		return os.Remove(sourcePath)
	}
	return nil
}

func migrateResourceFile(
	destinationRoot string,
	sourcePath string,
	destinationPath string,
	conflictPath string,
) error {
	if err := ensureSafeAbsoluteDirectory(destinationRoot, filepath.Dir(destinationPath)); err != nil {
		return err
	}
	destinationInfo, err := os.Lstat(destinationPath)
	if errors.Is(err, os.ErrNotExist) {
		return os.Rename(sourcePath, destinationPath)
	}
	if err != nil {
		return err
	}
	if destinationInfo.Mode()&os.ModeSymlink != 0 || !destinationInfo.Mode().IsRegular() {
		return fmt.Errorf("Provider 资源文件与原生路径类型冲突")
	}
	equal, err := regularFilesEqual(sourcePath, destinationPath)
	if err != nil {
		return err
	}
	if equal {
		return os.Remove(sourcePath)
	}
	return preserveResourceConflict(destinationRoot, sourcePath, conflictPath)
}

func preserveResourceConflict(
	destinationRoot string,
	sourcePath string,
	conflictPath string,
) error {
	if err := ensureSafeAbsoluteDirectory(destinationRoot, filepath.Dir(conflictPath)); err != nil {
		return err
	}
	conflictInfo, err := os.Lstat(conflictPath)
	if errors.Is(err, os.ErrNotExist) {
		return os.Rename(sourcePath, conflictPath)
	}
	if err != nil {
		return err
	}
	if conflictInfo.Mode()&os.ModeSymlink != 0 || !conflictInfo.Mode().IsRegular() {
		return fmt.Errorf("Provider 资源恢复路径冲突")
	}
	equal, err := regularFilesEqual(sourcePath, conflictPath)
	if err != nil {
		return err
	}
	if !equal {
		return fmt.Errorf("Provider 资源恢复文件内容冲突")
	}
	return os.Remove(sourcePath)
}

func assertManagedResourceLink(
	destinationRoot string,
	sourcePath string,
	destinationPath string,
) error {
	if err := ensureSafeAbsoluteDirectory(destinationRoot, filepath.Dir(destinationPath)); err != nil {
		return err
	}
	target, err := os.Readlink(sourcePath)
	if err != nil {
		return err
	}
	resolved := target
	if !filepath.IsAbs(resolved) {
		resolved = filepath.Join(filepath.Dir(sourcePath), resolved)
	}
	if filepath.Clean(resolved) != filepath.Clean(destinationPath) {
		return fmt.Errorf("Provider 资源 symlink 不指向原生路径")
	}
	return nil
}

func ensureSafeAbsoluteDirectory(root string, target string) error {
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) ||
		filepath.IsAbs(relative) {
		return fmt.Errorf("Provider 资源目标越出原生目录")
	}
	if relative == "." {
		return ensureSafeDirectory(root, nil)
	}
	return ensureSafeDirectory(root, strings.Split(relative, string(filepath.Separator)))
}

func ensureSafeDirectory(root string, segments []string) error {
	if err := assertPlainDirectory(root); err != nil {
		return err
	}
	current := root
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." || filepath.Base(segment) != segment {
			return fmt.Errorf("Provider 资源目录片段无效")
		}
		current = filepath.Join(current, segment)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			if err := os.Mkdir(current, 0o700); err != nil {
				return err
			}
			info, err = os.Lstat(current)
		}
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("Provider 原生目录包含不受信任路径")
		}
	}
	return nil
}

func regularFilesEqual(leftPath string, rightPath string) (bool, error) {
	leftInfo, err := os.Lstat(leftPath)
	if err != nil {
		return false, err
	}
	rightInfo, err := os.Lstat(rightPath)
	if err != nil {
		return false, err
	}
	if !leftInfo.Mode().IsRegular() || !rightInfo.Mode().IsRegular() || leftInfo.Size() != rightInfo.Size() {
		return false, nil
	}
	leftHash, err := hashRegularFile(leftPath)
	if err != nil {
		return false, err
	}
	rightHash, err := hashRegularFile(rightPath)
	if err != nil {
		return false, err
	}
	return leftHash == rightHash, nil
}

func hashRegularFile(filePath string) ([sha256.Size]byte, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return [sha256.Size]byte{}, err
	}
	defer func() {
		_ = file.Close()
	}()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return [sha256.Size]byte{}, err
	}
	var result [sha256.Size]byte
	copy(result[:], hash.Sum(nil))
	return result, nil
}
