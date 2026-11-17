package apps

import (
	"context"
	"debug/macho"
	"debug/pe"
	"encoding/xml"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/runtime/configsnapshot"
)

type ClaudeDesktopSelectedRecord struct {
	ExecutablePath string `json:"executablePath"`
	BundlePath     string `json:"bundlePath"`
}

type ClaudeDesktopPreparedLaunch struct {
	ProfileDir string `json:"profileDir"`
	ConfigID   string `json:"configId"`
}

// The preparation ID is continuity metadata, not a capability or proof that
// configuration stayed unchanged after Prepare released its transaction lock.
type ClaudeDesktopAccountLaunchRequest struct {
	Intent         string                      `json:"intent"`
	AIHomeDir      string                      `json:"aiHomeDir"`
	HostHomeDir    string                      `json:"hostHomeDir"`
	AccountRef     string                      `json:"accountRef"`
	SelectedRecord ClaudeDesktopSelectedRecord `json:"selectedRecord"`
	Prepared       ClaudeDesktopPreparedLaunch `json:"prepared"`
	PlanOnly       bool                        `json:"planOnly"`
}

type ClaudeDesktopAccountLaunchResult struct {
	OK              bool     `json:"ok"`
	Launched        bool     `json:"launched"`
	PlanOnly        bool     `json:"planOnly"`
	Reason          string   `json:"reason,omitempty"`
	OutcomeUnknown  bool     `json:"outcomeUnknown,omitempty"`
	ProfileDir      string   `json:"profileDir,omitempty"`
	Command         string   `json:"command,omitempty"`
	Args            []string `json:"args"`
	Cwd             string   `json:"cwd,omitempty"`
	TargetAvailable bool     `json:"targetAvailable"`
	LaunchHome      string   `json:"launchHome,omitempty"`
	UserDataDir     string   `json:"userDataDir,omitempty"`
}

type claudeDesktopLaunchPlan struct {
	command, cwd, root, profile string
	args, env                   []string
	target                      []os.FileInfo
}

var claudeLaunchConfigID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

func validClaudeLaunchPath(value string) bool {
	return filepath.IsAbs(value) && filepath.Clean(value) == value && !strings.ContainsRune(value, 0)
}

func claudeLaunchFailure(request ClaudeDesktopAccountLaunchRequest, reason string) ClaudeDesktopAccountLaunchResult {
	return ClaudeDesktopAccountLaunchResult{PlanOnly: request.PlanOnly, Reason: reason}
}

func claudeLaunchBinding(request ClaudeDesktopAccountLaunchRequest) (string, string, string) {
	if !validClaudeLaunchPath(request.AIHomeDir) || !validClaudeLaunchPath(request.HostHomeDir) ||
		!validClaudeLaunchPath(request.Prepared.ProfileDir) || !claudeLaunchConfigID.MatchString(request.Prepared.ConfigID) {
		return "", "", "desktop_launch_scope_invalid"
	}
	if _, err := accounts.ParseAccountRef(request.AccountRef); err != nil {
		return "", "", "invalid_account_scope"
	}
	root, err := configsnapshot.Resolve(request.AIHomeDir)
	if err != nil {
		return "", "", "invalid_account_scope"
	}
	requested := filepath.Join(request.AIHomeDir, "desktop-clients", "claude", request.AccountRef)
	profile, err := configsnapshot.Resolve(requested)
	if err != nil || profile != filepath.Join(root, "desktop-clients", "claude", request.AccountRef) || profile != request.Prepared.ProfileDir {
		return "", "", "desktop_profile_changed"
	}
	info, err := os.Stat(profile)
	if err != nil || !info.IsDir() {
		return "", "", "desktop_profile_unavailable"
	}
	return root, profile, ""
}

// Plan never discovers a replacement app, reads credentials or writes config.
func PlanClaudeDesktopAccountLaunch(ctx context.Context, request ClaudeDesktopAccountLaunchRequest, opts Options) ClaudeDesktopAccountLaunchResult {
	request.PlanOnly = true
	_, result := planClaudeDesktopAccountLaunch(ctx, request, opts)
	return result
}

func planClaudeDesktopAccountLaunch(ctx context.Context, request ClaudeDesktopAccountLaunchRequest, opts Options) (claudeDesktopLaunchPlan, ClaudeDesktopAccountLaunchResult) {
	fail := func(reason string) (claudeDesktopLaunchPlan, ClaudeDesktopAccountLaunchResult) {
		return claudeDesktopLaunchPlan{}, claudeLaunchFailure(request, reason)
	}
	if ctx == nil || ctx.Err() != nil {
		return fail("desktop_launch_cancelled")
	}
	if request.Intent != "account-api-launch" {
		return fail("desktop_launch_intent_invalid")
	}
	root, profile, reason := claudeLaunchBinding(request)
	if reason != "" {
		return fail(reason)
	}
	platform := resolvePlatform(opts)
	if platform != platformMacOS && platform != platformWindows {
		return fail("unsupported_platform")
	}
	catalog := resolveCatalog(opts)
	definition, ok := resolveProviderDefinition(catalog, "claude")
	if !ok || !definition.Clients.Desktop || definition.CLI == nil {
		return fail("unsupported_app")
	}
	cfg := resolveDesktopConfig(definition, platform)
	if cfg == nil {
		return fail("unsupported_platform")
	}
	record := request.SelectedRecord
	if !validClaudeLaunchPath(record.ExecutablePath) {
		return fail("desktop_executable_invalid")
	}
	base := filepath.Base(record.ExecutablePath)
	accepted := false
	for _, name := range cfg.ExecNames {
		if strings.EqualFold(base, name) {
			accepted = true
		}
	}
	if !accepted {
		return fail("desktop_executable_invalid")
	}
	plan := claudeDesktopLaunchPlan{command: record.ExecutablePath, cwd: filepath.Dir(record.ExecutablePath), root: root, profile: profile, args: []string{}}
	if platform == platformMacOS {
		if record.BundlePath == "" {
			marker := "/Contents/MacOS/"
			if index := strings.Index(record.ExecutablePath, marker); index >= 0 {
				record.BundlePath = record.ExecutablePath[:index]
			}
		}
		if !validClaudeLaunchPath(record.BundlePath) || !strings.HasSuffix(record.BundlePath, ".app") ||
			strings.Contains(strings.ToLower(record.BundlePath), ".app/contents/") ||
			record.ExecutablePath != filepath.Join(record.BundlePath, "Contents", "MacOS", base) {
			return fail("desktop_bundle_invalid")
		}
		plan.command = "/usr/bin/open"
		plan.args = []string{"-a", record.BundlePath, "--env", "CLAUDE_USER_DATA_DIR=" + profile}
	} else if record.BundlePath != "" {
		return fail("desktop_bundle_invalid")
	}
	// Read admission never executes the selected app or discovers a replacement.
	target, reason := admitClaudeLaunchTarget(record, platform, resolveArch(opts), cfg.BundleID)
	if reason != "" {
		return fail(reason)
	}
	available := len(target) != 0
	if !available && !request.PlanOnly {
		return fail("desktop_executable_unavailable")
	}
	plan.target = target
	env := resolveEnvMap(opts)
	for key := range env {
		for _, removed := range []string{"CODEX_HOME", "CODEX_SQLITE_HOME", "CODEX_ELECTRON_USER_DATA_PATH", "CLAUDE_CONFIG_DIR", "AIH_HOME_DIR", "AIH_HOST_HOME", "AI_HOME_DIR", "AIH_SESSION_INTENT", "CLAUDE_USER_DATA_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"} {
			if key == removed || platform == platformWindows && strings.EqualFold(key, removed) {
				delete(env, key)
			}
		}
		if platform == platformWindows && (strings.EqualFold(key, "HOME") || strings.EqualFold(key, "USERPROFILE") || strings.EqualFold(key, "HOMEDRIVE") || strings.EqualFold(key, "HOMEPATH")) {
			delete(env, key)
		}
	}
	env["HOME"], env["USERPROFILE"] = request.HostHomeDir, request.HostHomeDir
	env["CLAUDE_USER_DATA_DIR"] = profile
	if platform == platformWindows {
		if volume := filepath.VolumeName(request.HostHomeDir); len(volume) == 2 && volume[1] == ':' {
			env["HOMEDRIVE"] = volume
			env["HOMEPATH"] = strings.ReplaceAll(strings.TrimPrefix(request.HostHomeDir, volume), "/", `\`)
		}
	}
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		plan.env = append(plan.env, key+"="+env[key])
	}
	if ctx.Err() != nil {
		return fail("desktop_launch_cancelled")
	}
	return plan, ClaudeDesktopAccountLaunchResult{OK: true, PlanOnly: request.PlanOnly, ProfileDir: profile, Command: plan.command, Args: plan.args, Cwd: plan.cwd, TargetAvailable: available, LaunchHome: request.HostHomeDir, UserDataDir: profile}
}

// Launch only owns the process it directly creates. In particular an `open`
// PID is not the Claude PID, and a cancelled reply must not trigger name kills.
func LaunchClaudeDesktopAccount(ctx context.Context, request ClaudeDesktopAccountLaunchRequest, opts Options) ClaudeDesktopAccountLaunchResult {
	plan, result := planClaudeDesktopAccountLaunch(ctx, request, opts)
	if !result.OK || request.PlanOnly {
		return result
	}
	root, profile, reason := claudeLaunchBinding(request)
	if reason != "" || root != plan.root || profile != plan.profile {
		return claudeLaunchFailure(request, "desktop_profile_changed")
	}
	checked, current := planClaudeDesktopAccountLaunch(ctx, request, opts)
	if !current.OK {
		return current
	}
	if len(checked.target) != len(plan.target) {
		return claudeLaunchFailure(request, "desktop_target_changed")
	}
	for index, previous := range plan.target {
		observed := checked.target[index]
		if !os.SameFile(previous, observed) || previous.Size() != observed.Size() ||
			previous.Mode() != observed.Mode() || !previous.ModTime().Equal(observed.ModTime()) {
			return claudeLaunchFailure(request, "desktop_target_changed")
		}
	}
	if ctx.Err() != nil {
		return claudeLaunchFailure(request, "desktop_launch_cancelled")
	}
	if err := spawnClaudeDesktopDetached(plan); err != nil {
		return claudeLaunchFailure(request, "desktop_launch_failed")
	}
	if ctx.Err() != nil {
		result.OK, result.OutcomeUnknown = false, true
		result.Reason = "desktop_launch_outcome_unknown"
		return result
	}
	result.Launched = true
	return result
}

// The selected native image must be the bundle executable actually used by
// open -a. This admission establishes layout and image type, not publisher trust.
func admitClaudeLaunchTarget(record ClaudeDesktopSelectedRecord, platform, arch, bundleID string) ([]os.FileInfo, string) {
	info, err := os.Lstat(record.ExecutablePath)
	if os.IsNotExist(err) {
		return nil, ""
	}
	if err != nil || !info.Mode().IsRegular() || platform == platformMacOS && info.Mode().Perm()&0111 == 0 {
		return nil, "desktop_executable_invalid"
	}
	file, err := os.Open(record.ExecutablePath)
	if err != nil {
		return nil, "desktop_executable_unavailable"
	}
	defer file.Close()
	canonicalParent, parentErr := filepath.EvalSymlinks(filepath.Dir(record.ExecutablePath))
	canonicalTarget, targetErr := filepath.EvalSymlinks(record.ExecutablePath)
	if parentErr != nil || targetErr != nil || canonicalTarget != filepath.Join(canonicalParent, filepath.Base(record.ExecutablePath)) {
		return nil, "desktop_executable_invalid"
	}
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, "desktop_target_changed"
	}
	if platform == platformWindows {
		image, err := pe.NewFile(file)
		if err != nil || image.OptionalHeader == nil || image.Characteristics&pe.IMAGE_FILE_EXECUTABLE_IMAGE == 0 || image.Characteristics&pe.IMAGE_FILE_DLL != 0 {
			return nil, "desktop_executable_invalid"
		}
		compatible := image.Machine == pe.IMAGE_FILE_MACHINE_AMD64 && (arch == "x64" || arch == "arm64") ||
			image.Machine == pe.IMAGE_FILE_MACHINE_ARM64 && arch == "arm64" || image.Machine == pe.IMAGE_FILE_MACHINE_I386
		if !compatible {
			return nil, "desktop_executable_invalid"
		}
		return []os.FileInfo{opened}, ""
	}
	compatible := func(image *macho.File) bool {
		return image.Type == macho.TypeExec && (image.Cpu == macho.CpuArm64 && arch == "arm64" || image.Cpu == macho.CpuAmd64 && (arch == "x64" || arch == "arm64"))
	}
	native := false
	if fat, err := macho.NewFatFile(file); err == nil {
		for _, image := range fat.Arches {
			native = native || compatible(image.File)
		}
	} else if thin, err := macho.NewFile(file); err == nil {
		native = compatible(thin)
	}
	if !native {
		return nil, "desktop_executable_invalid"
	}
	bundle, err := os.Lstat(record.BundlePath)
	if err != nil || !bundle.IsDir() {
		return nil, "desktop_bundle_invalid"
	}
	canonicalBundle, err := filepath.EvalSymlinks(record.BundlePath)
	canonicalExecutable, executableErr := filepath.EvalSymlinks(record.ExecutablePath)
	if err != nil || executableErr != nil || canonicalExecutable != filepath.Join(canonicalBundle, "Contents", "MacOS", filepath.Base(record.ExecutablePath)) {
		return nil, "desktop_bundle_invalid"
	}
	plistPath := filepath.Join(record.BundlePath, "Contents", "Info.plist")
	metadata, err := os.Lstat(plistPath)
	canonicalMetadata, metadataErr := filepath.EvalSymlinks(plistPath)
	if err != nil || !metadata.Mode().IsRegular() || metadata.Size() > 1024*1024 || metadataErr != nil || canonicalMetadata != filepath.Join(canonicalBundle, "Contents", "Info.plist") {
		return nil, "desktop_bundle_metadata_invalid"
	}
	plist, err := os.Open(plistPath)
	if err != nil {
		return nil, "desktop_bundle_metadata_invalid"
	}
	defer plist.Close()
	openedMetadata, err := plist.Stat()
	if err != nil || !os.SameFile(metadata, openedMetadata) {
		return nil, "desktop_target_changed"
	}
	// Binary plist is deliberately fail closed until a canonical pure-Go reader
	// is available; do not shell out to plutil or execute an app probe.
	values := claudeBundleLaunchMetadata(io.LimitReader(plist, 1024*1024+1))
	if values["CFBundleIdentifier"] != bundleID || values["CFBundleExecutable"] != filepath.Base(record.ExecutablePath) || values["CFBundlePackageType"] != "APPL" {
		return nil, "desktop_bundle_metadata_invalid"
	}
	return []os.FileInfo{opened, bundle, openedMetadata}, ""
}

func claudeBundleLaunchMetadata(reader io.Reader) map[string]string {
	decoder := xml.NewDecoder(reader)
	next := func() xml.Token {
		for {
			token, err := decoder.Token()
			if err != nil {
				return nil
			}
			switch value := token.(type) {
			case xml.CharData:
				if strings.TrimSpace(string(value)) != "" {
					return nil
				}
			case xml.Comment, xml.ProcInst, xml.Directive:
			default:
				return token
			}
		}
	}
	start, ok := next().(xml.StartElement)
	if !ok || start.Name.Local != "plist" {
		return nil
	}
	dict, ok := next().(xml.StartElement)
	if !ok || dict.Name.Local != "dict" {
		return nil
	}
	values, seen := map[string]string{}, map[string]bool{}
	for {
		token := next()
		if end, ok := token.(xml.EndElement); ok && end.Name == dict.Name {
			break
		}
		keyElement, ok := token.(xml.StartElement)
		if !ok || keyElement.Name.Local != "key" {
			return nil
		}
		var key string
		if decoder.DecodeElement(&key, &keyElement) != nil || seen[key] {
			return nil
		}
		seen[key] = true
		valueElement, ok := next().(xml.StartElement)
		if !ok {
			return nil
		}
		if key == "CFBundleIdentifier" || key == "CFBundleExecutable" || key == "CFBundlePackageType" {
			var value string
			if valueElement.Name.Local != "string" || decoder.DecodeElement(&value, &valueElement) != nil {
				return nil
			}
			values[key] = value
		} else if decoder.Skip() != nil {
			return nil
		}
	}
	end, ok := next().(xml.EndElement)
	if !ok || end.Name != start.Name {
		return nil
	}
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return values
		}
		if err != nil {
			return nil
		}
		switch value := token.(type) {
		case xml.Comment, xml.ProcInst:
		case xml.CharData:
			if strings.TrimSpace(string(value)) != "" {
				return nil
			}
		default:
			return nil
		}
	}
}
