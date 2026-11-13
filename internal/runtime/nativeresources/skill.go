package nativeresources

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/providerconfigs"
)

var (
	resourceIDPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	skillDigestPattern  = regexp.MustCompile(`^[a-f0-9]{64}$`)
	skillFrontmatterRe  = regexp.MustCompile(`(?s)^---\r?\n(.*?)\r?\n---(?:\r?\n|$)`)
)

// SkillPackage 表示校验通过的本地 Skill 资源包内容与摘要。
type SkillPackage struct {
	ID           string
	Files        []PackageFile
	Digest       string
	Instructions string
}

// validateSkillID 校验 Skill ID 格式。
func validateSkillID(id string) (string, error) {
	if !resourceIDPattern.MatchString(id) {
		return "", fail("skill_id_invalid")
	}
	return id, nil
}

// readSkillPackage 读取并校验 Skill 包目录（包含 SKILL.md YAML Frontmatter）。
func readSkillPackage(root string) (SkillPackage, error) {
	files, err := readTreeFiles(root, "skill_source")
	if err != nil {
		return SkillPackage{}, err
	}
	var skillFile *PackageFile
	var instructionFile *PackageFile
	for i := range files {
		if files[i].Name == "SKILL.md" {
			skillFile = &files[i]
		} else if files[i].Name == "instructions.md" {
			instructionFile = &files[i]
		}
	}
	if skillFile == nil {
		return SkillPackage{}, fail("skill_manifest_missing")
	}
	text := string(skillFile.Content)
	loc := skillFrontmatterRe.FindStringSubmatchIndex(text)
	if loc == nil {
		return SkillPackage{}, fail("skill_manifest_invalid")
	}
	headerYAML := text[loc[2]:loc[3]]
	parsed, parseErr := providerconfigs.ParseYAML(headerYAML)
	if parseErr != nil {
		return SkillPackage{}, fail("skill_manifest_invalid")
	}
	meta, ok := parsed.(map[string]any)
	if !ok {
		return SkillPackage{}, fail("skill_manifest_invalid")
	}
	nameRaw, _ := meta["name"].(string)
	id, err := validateSkillID(nameRaw)
	if err != nil {
		return SkillPackage{}, err
	}
	desc, ok := meta["description"].(string)
	if !ok || strings.TrimSpace(desc) == "" {
		return SkillPackage{}, fail("skill_description_missing")
	}
	instructions := text[loc[1]:]
	if instructionFile != nil {
		instructions = string(instructionFile.Content)
	}
	return SkillPackage{
		ID:           id,
		Files:        files,
		Digest:       digestFiles(files),
		Instructions: instructions,
	}, nil
}

func randomSuffix() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func skillBlock(id, content string) string {
	return fmt.Sprintf("<!-- aih-skill:%s:begin -->\n%s\n<!-- aih-skill:%s:end -->\n", id, strings.TrimSpace(content), id)
}

func skillBlockRange(text, id string) (start, end int, found bool, err error) {
	begin := fmt.Sprintf("<!-- aih-skill:%s:begin -->", id)
	endTag := fmt.Sprintf("<!-- aih-skill:%s:end -->", id)
	startIdx := strings.Index(text, begin)
	if startIdx < 0 && !strings.Contains(text, endTag) {
		return 0, 0, false, nil
	}
	if startIdx < 0 {
		return 0, 0, false, fail("skill_block_invalid")
	}
	restStart := startIdx + len(begin)
	finishRel := strings.Index(text[restStart:], endTag)
	if finishRel < 0 {
		return 0, 0, false, fail("skill_block_invalid")
	}
	finishIdx := restStart + finishRel
	if strings.Contains(text[restStart:], begin) || strings.Contains(text[finishIdx+len(endTag):], endTag) {
		return 0, 0, false, fail("skill_block_invalid")
	}
	endIdx := finishIdx + len(endTag)
	if endIdx < len(text) && text[endIdx] == '\n' {
		endIdx++
	}
	return startIdx, endIdx, true, nil
}

// isLegacyDirectory 判断目录是否为历史 aih-collab 内置投影（仅限显式标记/同源软链接管）。
func isLegacyDirectory(target string, pkg SkillPackage, legacySource string) bool {
	if pkg.ID != "aih-collab" || strings.TrimSpace(legacySource) == "" {
		return false
	}
	info, err := lstatMaybe(target)
	if err != nil || info == nil {
		return false
	}
	if info.Mode()&os.ModeSymlink != 0 {
		linkDest, readErr := os.Readlink(target)
		if readErr != nil {
			return false
		}
		if !filepath.IsAbs(linkDest) {
			linkDest = filepath.Join(filepath.Dir(target), linkDest)
		}
		absDest, _ := filepath.Abs(linkDest)
		absLegacy, _ := filepath.Abs(legacySource)
		return absDest == absLegacy
	}
	if !info.IsDir() {
		return false
	}
	marker, readErr := os.ReadFile(filepath.Join(target, ".aih-managed"))
	if readErr != nil || strings.TrimSpace(string(marker)) != "v1" {
		return false
	}
	files, filesErr := readTreeFiles(target, "skill_source")
	if filesErr != nil {
		return false
	}
	filtered := make([]PackageFile, 0, len(files))
	for _, f := range files {
		if f.Name != ".aih-managed" {
			filtered = append(filtered, f)
		}
	}
	return digestFiles(filtered) == pkg.Digest
}

func legacyInstructionRange(text string, pkg SkillPackage, legacySource string) (start, end int, found bool) {
	if pkg.ID != "aih-collab" || strings.TrimSpace(legacySource) == "" {
		return 0, 0, false
	}
	legacyBlock := fmt.Sprintf("<!-- aih-collab:v1:begin -->\n%s\n<!-- aih-collab:end -->", strings.TrimSpace(pkg.Instructions))
	startIdx := strings.Index(text, legacyBlock)
	if startIdx < 0 || strings.Contains(text[startIdx+1:], "<!-- aih-collab:v1:begin -->") {
		return 0, 0, false
	}
	endIdx := startIdx + len(legacyBlock)
	if endIdx < len(text) && text[endIdx] == '\n' {
		endIdx++
	}
	return startIdx, endIdx, true
}

type skillProjection interface {
	inspect(record ManagedRecord, pkg SkillPackage) string
	apply(record ManagedRecord, pkg SkillPackage, previous *ManagedRecord, previousPkg *SkillPackage, legacySource string) error
	remove(record ManagedRecord, pkg SkillPackage) error
}

type skillDirProjection struct{}

func (skillDirProjection) inspect(record ManagedRecord, _ SkillPackage) string {
	info, err := lstatMaybe(record.Target)
	if err != nil {
		return "conflict"
	}
	if info == nil {
		return "absent"
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "conflict"
	}
	files, err := readTreeFiles(record.Target, "skill_source")
	if err != nil {
		return "modified"
	}
	if digestFiles(files) == record.Digest {
		return "present"
	}
	return "modified"
}

func (p skillDirProjection) apply(record ManagedRecord, pkg SkillPackage, previous *ManagedRecord, _ *SkillPackage, legacySource string) error {
	info, err := lstatMaybe(record.Target)
	if err != nil {
		return err
	}
	if info != nil {
		if previous == nil {
			if !isLegacyDirectory(record.Target, pkg, legacySource) {
				return fail("skill_target_conflict")
			}
		} else {
			if p.inspect(*previous, pkg) != "present" {
				return fail("skill_target_modified")
			}
			if record.Digest == previous.Digest {
				return nil
			}
		}
	}
	if err := os.MkdirAll(filepath.Dir(record.Target), 0o700); err != nil {
		return err
	}
	tmpDir := fmt.Sprintf("%s.%s.tmp", record.Target, randomSuffix())
	backupDir := tmpDir + ".old"
	defer func() { _ = os.RemoveAll(tmpDir) }()

	if err := writePackageFiles(tmpDir, pkg.Files); err != nil {
		return err
	}
	if info != nil {
		if err := os.Rename(record.Target, backupDir); err != nil {
			return err
		}
	}
	if err := os.Rename(tmpDir, record.Target); err != nil {
		if info != nil {
			_ = os.Rename(backupDir, record.Target)
		}
		return err
	}
	if info != nil {
		_ = os.RemoveAll(backupDir)
	}
	return nil
}

func (p skillDirProjection) remove(record ManagedRecord, pkg SkillPackage) error {
	status := p.inspect(record, pkg)
	if status == "absent" {
		return nil
	}
	if status != "present" {
		return fail("skill_target_modified")
	}
	return os.RemoveAll(record.Target)
}

type skillInstructionProjection struct{}

func readInstructionsFile(file string) (string, error) {
	info, err := lstatMaybe(file)
	if err != nil {
		return "", err
	}
	if info == nil {
		return "", nil
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", fail("skill_target_conflict")
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func (skillInstructionProjection) inspect(record ManagedRecord, pkg SkillPackage) string {
	text, err := readInstructionsFile(record.Target)
	if err != nil {
		return "conflict"
	}
	start, end, found, err := skillBlockRange(text, record.ID)
	if err != nil {
		return "conflict"
	}
	if !found {
		return "absent"
	}
	if text[start:end] == skillBlock(record.ID, pkg.Instructions) {
		return "present"
	}
	return "modified"
}

func (p skillInstructionProjection) apply(record ManagedRecord, pkg SkillPackage, previous *ManagedRecord, previousPkg *SkillPackage, legacySource string) error {
	text, err := readInstructionsFile(record.Target)
	if err != nil {
		return err
	}
	if previous == nil {
		if ls, le, found := legacyInstructionRange(text, pkg, legacySource); found {
			next := text[:ls] + skillBlock(record.ID, pkg.Instructions) + text[le:]
			return atomicWriteFile(record.Target, []byte(next), 0o600)
		}
		if legacySource != "" && strings.Contains(text, "<!-- aih-collab:") {
			return fail("skill_target_modified")
		}
	}
	start, end, found, err := skillBlockRange(text, record.ID)
	if err != nil {
		return err
	}
	if found {
		if previous == nil {
			return fail("skill_target_conflict")
		}
		if previousPkg == nil || p.inspect(*previous, *previousPkg) != "present" {
			return fail("skill_target_modified")
		}
		next := text[:start] + skillBlock(record.ID, pkg.Instructions) + text[end:]
		if next != text {
			return atomicWriteFile(record.Target, []byte(next), 0o600)
		}
		return nil
	}
	prefix := text
	if prefix != "" && !strings.HasSuffix(prefix, "\n") {
		prefix += "\n"
	}
	return atomicWriteFile(record.Target, []byte(prefix+skillBlock(record.ID, pkg.Instructions)), 0o600)
}

func (p skillInstructionProjection) remove(record ManagedRecord, pkg SkillPackage) error {
	text, err := readInstructionsFile(record.Target)
	if err != nil {
		return err
	}
	start, end, found, err := skillBlockRange(text, record.ID)
	if err != nil {
		return err
	}
	if !found {
		return nil
	}
	if p.inspect(record, pkg) != "present" {
		return fail("skill_target_modified")
	}
	next := text[:start] + text[end:]
	return atomicWriteFile(record.Target, []byte(next), 0o600)
}

var skillProjections = map[string]skillProjection{
	"native":          skillDirProjection{},
	"projection-only": skillInstructionProjection{},
}

type skillManager struct {
	aiHomeDir   string
	hostHomeDir string
	packageRoot string
	registry    map[string]ResourceCapability
	store       *managedStore
}

func newSkillManager(aiHomeDir, hostHomeDir string, registry map[string]ResourceCapability, store *managedStore) (*skillManager, error) {
	if strings.TrimSpace(aiHomeDir) == "" || strings.TrimSpace(hostHomeDir) == "" {
		return nil, fail("skill_home_required")
	}
	return &skillManager{
		aiHomeDir:   aiHomeDir,
		hostHomeDir: hostHomeDir,
		packageRoot: filepath.Join(aiHomeDir, "managed-resources", "skills"),
		registry:    registry,
		store:       store,
	}, nil
}

func (m *skillManager) target(id, provider string) (providerName, mode, targetPath string, err error) {
	if _, err := validateSkillID(id); err != nil {
		return "", "", "", err
	}
	p := strings.ToLower(strings.TrimSpace(provider))
	capVal, ok := m.registry[p]
	if !ok {
		return "", "", "", fail("skill_provider_unsupported")
	}
	adapter := skillProjections[capVal.Mode]
	var rel string
	if len(capVal.Paths) > 0 {
		rel = capVal.Paths[0]
	}
	root := resolveProjectionRoot(m.hostHomeDir, p, capVal.PathBase)
	if adapter == nil || rel == "" || root == "" {
		return "", "", "", fail("skill_provider_unsupported")
	}
	if filepath.IsAbs(rel) || hasParentSegment(rel) {
		return "", "", "", fail("skill_path_invalid")
	}
	if capVal.Mode == "native" {
		targetPath = filepath.Join(root, filepath.FromSlash(rel), id)
	} else {
		targetPath = filepath.Join(root, filepath.FromSlash(rel))
	}
	return p, capVal.Mode, targetPath, nil
}

func hasParentSegment(p string) bool {
	for _, seg := range strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' }) {
		if seg == ".." {
			return true
		}
	}
	return false
}

func (m *skillManager) snapshot(pkg SkillPackage) error {
	dir := filepath.Join(m.packageRoot, pkg.Digest)
	if _, err := os.Stat(dir); err == nil {
		existing, readErr := readSkillPackage(dir)
		if readErr != nil || existing.Digest != pkg.Digest {
			return fail("skill_snapshot_modified")
		}
		return nil
	}
	if err := os.MkdirAll(m.packageRoot, 0o700); err != nil {
		return err
	}
	tmpDir := fmt.Sprintf("%s.%s.tmp", dir, randomSuffix())
	defer func() { _ = os.RemoveAll(tmpDir) }()
	if err := writePackageFiles(tmpDir, pkg.Files); err != nil {
		return err
	}
	return os.Rename(tmpDir, dir)
}

func (m *skillManager) packageFor(rec ManagedRecord) (SkillPackage, error) {
	if !skillDigestPattern.MatchString(rec.Digest) {
		return SkillPackage{}, fail("skill_digest_invalid")
	}
	pkg, err := readSkillPackage(filepath.Join(m.packageRoot, rec.Digest))
	if err != nil || pkg.Digest != rec.Digest || pkg.ID != rec.ID {
		return SkillPackage{}, fail("skill_snapshot_modified")
	}
	return pkg, nil
}

func findSkillIndex(resources []ManagedRecord, id, provider string) int {
	for i := range resources {
		r := resources[i]
		if r.Kind == "skill" && r.ID == id && r.Provider == provider && r.Scope == "host" {
			return i
		}
	}
	return -1
}

func (m *skillManager) install(ctx context.Context, source, provider, legacySource string, onlyIfDefault bool) (ManagedRecord, error) {
	absSource, err := filepath.Abs(source)
	if err != nil {
		return ManagedRecord{}, fail("skill_source_missing")
	}
	pkg, err := readSkillPackage(absSource)
	if err != nil {
		return ManagedRecord{}, err
	}
	prov, mode, targetPath, err := m.target(pkg.ID, provider)
	if err != nil {
		return ManagedRecord{}, err
	}
	res, err := m.store.update(ctx, func(st *ManagedState) (any, error) {
		idx := findSkillIndex(st.Resources, pkg.ID, prov)
		var prevPtr *ManagedRecord
		var prevPkgPtr *SkillPackage
		if idx >= 0 {
			prevCopy := st.Resources[idx]
			if onlyIfDefault && (!prevCopy.Enabled || prevCopy.Removed) {
				return prevCopy, nil
			}
			pp, pErr := m.packageFor(prevCopy)
			if pErr != nil {
				return nil, pErr
			}
			prevPtr = &prevCopy
			prevPkgPtr = &pp
		}
		if snapErr := m.snapshot(pkg); snapErr != nil {
			return nil, snapErr
		}
		now := time.Now().UnixMilli()
		rec := ManagedRecord{
			Kind:      "skill",
			ID:        pkg.ID,
			Provider:  prov,
			Scope:     "host",
			Mode:      mode,
			Target:    targetPath,
			Digest:    pkg.Digest,
			Enabled:   true,
			Removed:   false,
			CreatedAt: now,
			UpdatedAt: now,
		}
		if prevPtr != nil {
			rec.CreatedAt = prevPtr.CreatedAt
		}
		adapter := skillProjections[rec.Mode]
		if applyErr := adapter.apply(rec, pkg, prevPtr, prevPkgPtr, legacySource); applyErr != nil {
			return nil, applyErr
		}
		if prevPtr != nil && prevPtr.Target == rec.Target && prevPtr.Mode == rec.Mode &&
			prevPtr.Digest == rec.Digest && prevPtr.Enabled == rec.Enabled && prevPtr.Removed == rec.Removed {
			return *prevPtr, nil
		}
		if idx >= 0 {
			st.Resources[idx] = rec
		} else {
			st.Resources = append(st.Resources, rec)
		}
		return rec, nil
	})
	if err != nil {
		return ManagedRecord{}, err
	}
	return res.(ManagedRecord), nil
}

func (m *skillManager) change(ctx context.Context, id, provider, action string) (ManagedRecord, error) {
	if action != "enable" && action != "disable" && action != "remove" {
		return ManagedRecord{}, fail("skill_action_invalid")
	}
	prov, _, _, err := m.target(id, provider)
	if err != nil {
		return ManagedRecord{}, err
	}
	res, err := m.store.update(ctx, func(st *ManagedState) (any, error) {
		idx := findSkillIndex(st.Resources, id, prov)
		if idx < 0 || (st.Resources[idx].Removed && action != "remove") {
			return nil, fail("skill_not_installed")
		}
		rec := st.Resources[idx]
		pkg, pkgErr := m.packageFor(rec)
		if pkgErr != nil {
			return nil, pkgErr
		}
		adapter := skillProjections[rec.Mode]
		if action == "enable" {
			if err := adapter.apply(rec, pkg, &rec, &pkg, ""); err != nil {
				return nil, err
			}
		} else {
			if err := adapter.remove(rec, pkg); err != nil {
				return nil, err
			}
		}
		enabled := action == "enable"
		removed := action == "remove"
		if rec.Enabled != enabled || rec.Removed != removed {
			rec.Enabled = enabled
			rec.Removed = removed
			rec.UpdatedAt = time.Now().UnixMilli()
			st.Resources[idx] = rec
		}
		return rec, nil
	})
	if err != nil {
		return ManagedRecord{}, err
	}
	return res.(ManagedRecord), nil
}

func (m *skillManager) list(ctx context.Context, provider string) (int, []ManagedRecord, error) {
	st, err := m.store.get(ctx)
	if err != nil {
		return 0, nil, err
	}
	p := strings.ToLower(strings.TrimSpace(provider))
	out := make([]ManagedRecord, 0)
	for _, r := range st.Resources {
		if r.Kind == "skill" && !r.Removed && (p == "" || r.Provider == p) {
			out = append(out, r)
		}
	}
	return st.Revision, out, nil
}
