package claudedesktopconfig

import (
	"bytes"
	"encoding/json"
	"io"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/claudedesktopcredential"
	"github.com/madou1217/ai_home/internal/runtime/configsnapshot"
	"github.com/madou1217/ai_home/internal/runtime/jsondocument"
	"github.com/madou1217/ai_home/internal/runtime/regularnativefile"
)

type document struct {
	snapshot configsnapshot.Snapshot
	value    map[string]any
}

func readObject(file string, missing map[string]any) (document, error) {
	snapshot, err := configsnapshot.Read(file)
	if err != nil {
		return document{}, err
	}
	if !snapshot.Exists {
		return document{snapshot: snapshot, value: missing}, nil
	}
	value, err := jsondocument.Object(snapshot.Content)
	if err != nil {
		return document{}, fail("desktop_config_invalid")
	}
	return document{snapshot: snapshot, value: value}, nil
}
func clone(value map[string]any) map[string]any {
	out := make(map[string]any, len(value))
	for key, v := range value {
		out[key] = v
	}
	return out
}
func encode(value any) ([]byte, error) {
	raw, err := json.MarshalIndent(value, "", "  ")
	return append(raw, '\n'), err
}
func sameValue(a, b any) bool {
	normalize := func(v any) ([]byte, error) {
		raw, e := json.Marshal(v)
		if e != nil {
			return nil, e
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		var object any
		if e = decoder.Decode(&object); e != nil {
			return nil, e
		}
		return json.Marshal(object)
	}
	one, e1 := normalize(a)
	two, e2 := normalize(b)
	return e1 == nil && e2 == nil && bytes.Equal(one, two)
}
func ownedManaged(current, managed map[string]any) bool {
	for key, value := range managed {
		if !sameValue(current[key], value) {
			return false
		}
	}
	return true
}
func knownLegacy(current map[string]any, desired map[string]any, mode string) bool {
	if mode == "api" && knownLegacyNodeGateway(current, desired) {
		return true
	}
	if mode == "web" {
		return len(current) == 0
	}
	if len(current) != len(desired) {
		return false
	}
	for key, value := range desired {
		if key == "inferenceGatewayBaseUrl" {
			old, ok := current[key].(string)
			if !ok || old == "" {
				return false
			}
			continue
		}
		if !sameValue(current[key], value) {
			return false
		}
	}
	return true
}

// Recognize only this known legacy package shape, with the same AIH root
// already covered by requestSignature. Static layout and byte checks do not
// authenticate the original writer or authorize application control.
func knownLegacyNodeGateway(current, desired map[string]any) bool {
	if !regularnativefile.Supported() {
		return false
	}
	if len(current) != 7 || len(desired) != 7 {
		return false
	}
	args, ok := desired["inferenceCredentialHelperArgs"].([]any)
	if !ok || len(args) != 3 || args[0] != claudedesktopcredential.Command || args[1] != "--ai-home-dir" {
		return false
	}
	aiHome, ok := args[2].(string)
	if !ok || !filepath.IsAbs(aiHome) || filepath.Clean(aiHome) != aiHome {
		return false
	}
	helper, ok := desired["inferenceCredentialHelper"].(string)
	if !ok {
		return false
	}
	native, err := claudedesktopcredential.ResolveExecutable(claudedesktopcredential.CommandOptions{ExplicitPath: helper, StrictRegularFiles: true})
	if err != nil || native != helper {
		return false
	}
	platform, arch, name := runtime.GOOS, runtime.GOARCH, "aih-go"
	if platform == "windows" {
		platform, name = "win32", "aih-go.exe"
	}
	if arch == "amd64" {
		arch = "x64"
	}
	root := filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(native))))
	if filepath.Join(root, "bin", "native", platform+"-"+arch, name) != native {
		return false
	}
	// 旧版 helper 脚本已随 Node 清理删除；升级识别只依赖配置里的稳定路径形状，
	// 不再要求旧脚本仍然存在。Node 可执行文件本身仍要校验，避免把伪造路径当旧配置。
	script := filepath.Join(root, "bin", "claude-desktop-credential.js")
	oldArgs, ok := current["inferenceCredentialHelperArgs"].([]any)
	if !ok || len(oldArgs) != 3 || oldArgs[0] != script || oldArgs[1] != "--ai-home-dir" || oldArgs[2] != aiHome {
		return false
	}
	node, ok := current["inferenceCredentialHelper"].(string)
	if !ok || !legacyNativeNode(node) {
		return false
	}
	// Compare the complete seven-key entry, including the gateway URL. Neither
	// display name, basename alone, extra fields nor a different scope is enough.
	rebound := clone(current)
	rebound["inferenceCredentialHelper"] = helper
	rebound["inferenceCredentialHelperArgs"] = args
	return sameValue(rebound, desired)
}

func legacyNativeNode(path string) bool {
	if !regularnativefile.Supported() {
		return false
	}
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return false
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return false
	}
	expected := "node"
	if runtime.GOOS == "windows" {
		expected = "node.exe"
	}
	if filepath.Base(real) != expected {
		return false
	}
	fileOptions := regularnativefile.Options{RequireExecutable: true}
	file, err := regularnativefile.Open(real, fileOptions)
	if err != nil {
		return false
	}
	defer file.Close()
	initial, err := file.Stat()
	if err != nil {
		return false
	}
	var header [4]byte
	if _, err = io.ReadFull(file, header[:]); err != nil || regularnativefile.Verify(file, initial, fileOptions) != nil {
		return false
	}
	magic := string(header[:])
	return magic == "\x7fELF" || strings.HasPrefix(magic, "MZ") ||
		magic == "\xcf\xfa\xed\xfe" || magic == "\xfe\xed\xfa\xcf" ||
		magic == "\xce\xfa\xed\xfe" || magic == "\xfe\xed\xfa\xce" ||
		magic == "\xca\xfe\xba\xbe" || magic == "\xbe\xba\xfe\xca" ||
		magic == "\xca\xfe\xba\xbf" || magic == "\xbf\xba\xfe\xca"
}

func buildPlan(o Options, profile string) (transaction, error) {
	meta, err := readObject(filepath.Join(profile, "configLibrary", "_meta.json"), map[string]any{"appliedId": "", "entries": []any{}})
	if err != nil {
		return transaction{}, err
	}
	desktop, err := readObject(filepath.Join(profile, "claude_desktop_config.json"), map[string]any{})
	if err != nil {
		return transaction{}, err
	}
	var developer document
	if o.Mode == "api" {
		developer, err = readObject(filepath.Join(profile, "developer_settings.json"), map[string]any{})
		if err != nil {
			return transaction{}, err
		}
	}
	owned, err := readObject(filepath.Join(profile, stateName), map[string]any{"version": json.Number("1"), "entries": map[string]any{}})
	if err != nil {
		return transaction{}, err
	}
	rawState, err := json.Marshal(owned.value)
	if err != nil {
		return transaction{}, err
	}
	var state managedState
	stateDecoder := json.NewDecoder(bytes.NewReader(rawState))
	stateDecoder.UseNumber()
	if stateDecoder.Decode(&state) != nil || state.Version != 1 || state.Entries == nil {
		return transaction{}, fail("desktop_ownership_invalid")
	}
	if len(state.Entries) > 2 {
		return transaction{}, fail("desktop_ownership_invalid")
	}
	for mode, r := range state.Entries {
		if (mode != "api" && mode != "web") || !idPattern.MatchString(r.ID) || r.Managed == nil || !validReceiptMode(mode, r.Managed) {
			return transaction{}, fail("desktop_ownership_invalid")
		}
	}
	rawEntries, ok := meta.value["entries"].([]any)
	if !ok {
		return transaction{}, fail("config_library_entries_invalid")
	}
	if _, ok := meta.value["appliedId"].(string); !ok {
		return transaction{}, fail("config_library_applied_id_invalid")
	}
	entries := make([]any, len(rawEntries))
	seen := map[string]bool{}
	selected := -1
	name := "ai-home API"
	if o.Mode == "web" {
		name = "ai-home Web"
	}
	prior, hasReceipt := state.Entries[o.Mode]
	for i, item := range rawEntries {
		entry, ok := item.(map[string]any)
		if !ok {
			return transaction{}, fail("config_library_entry_invalid")
		}
		id, idOK := entry["id"].(string)
		title, titleOK := entry["name"].(string)
		if !idOK || !idPattern.MatchString(id) || !titleOK || strings.TrimSpace(title) == "" || seen[id] {
			return transaction{}, fail("config_library_entry_invalid")
		}
		seen[id] = true
		entries[i] = clone(entry)
		match := (hasReceipt && id == prior.ID) || (!hasReceipt && title == name)
		if match {
			if selected >= 0 {
				return transaction{}, fail("desktop_entry_ambiguous")
			}
			selected = i
		}
	}
	if active := meta.value["appliedId"].(string); active != "" && !seen[active] {
		return transaction{}, fail("config_library_applied_id_invalid")
	}
	if hasReceipt && selected < 0 {
		return transaction{}, fail("desktop_managed_entry_missing")
	}
	desired := map[string]any{}
	if o.Mode == "api" {
		desired = apiConfig(o)
	}
	var current document
	entryID := ""
	var entryRow map[string]any
	if selected >= 0 {
		entryRow = entries[selected].(map[string]any)
		entryID = entryRow["id"].(string)
		current, err = readObject(filepath.Join(profile, "configLibrary", entryID+".json"), map[string]any{})
		if err != nil {
			return transaction{}, err
		}
		if !current.snapshot.Exists {
			return transaction{}, fail("desktop_managed_entry_missing")
		}
		if hasReceipt {
			if !ownedManaged(current.value, prior.Managed) {
				return transaction{}, fail("desktop_managed_entry_changed")
			}
		} else if !knownLegacy(current.value, desired, o.Mode) {
			return transaction{}, fail("desktop_entry_ownership_conflict")
		}
	} else {
		entryRow = map[string]any{"name": name}
		current.value = map[string]any{}
	}
	nextEntry := clone(current.value)
	// Replace only fields owned by the previous receipt; extension metadata stays.
	if hasReceipt {
		for key := range prior.Managed {
			delete(nextEntry, key)
		}
	}
	for key, value := range desired {
		nextEntry[key] = value
	}
	oldEntry := current
	oldID := entryID
	changedEntry := selected < 0 || !sameValue(current.value, nextEntry)
	if changedEntry {
		entryID, err = newID()
		if err != nil {
			return transaction{}, err
		}
		destination, err := readObject(filepath.Join(profile, "configLibrary", entryID+".json"), map[string]any{})
		if err != nil {
			return transaction{}, err
		}
		if destination.snapshot.Exists {
			return transaction{}, fail("desktop_entry_id_conflict")
		}
		current.snapshot = destination.snapshot
		entryRow["id"] = entryID
		if selected < 0 {
			entries = append(entries, entryRow)
		} else {
			entries[selected] = entryRow
		}
	}
	state.Entries[o.Mode] = receipt{ID: entryID, Managed: desired}
	// Keep forward-compatible receipt metadata without granting it ownership of
	// any new managed key. Only this mode's id/managed fields are replaced.
	nextOwned := clone(owned.value)
	priorEntries, ok := owned.value["entries"].(map[string]any)
	if !ok {
		return transaction{}, fail("desktop_ownership_invalid")
	}
	nextReceipts := clone(priorEntries)
	nextReceipt := map[string]any{}
	if value, exists := priorEntries[o.Mode]; exists {
		object, ok := value.(map[string]any)
		if !ok {
			return transaction{}, fail("desktop_ownership_invalid")
		}
		nextReceipt = clone(object)
	}
	nextReceipt["id"] = entryID
	nextReceipt["managed"] = desired
	nextReceipts[o.Mode] = nextReceipt
	nextOwned["entries"] = nextReceipts
	nextMeta := clone(meta.value)
	nextMeta["entries"] = entries
	nextMeta["appliedId"] = entryID
	nextDesktop := clone(desktop.value)
	nextDesktop["deploymentMode"] = "1p"
	if o.Mode == "api" {
		nextDesktop["deploymentMode"] = "3p"
	}
	delete(nextDesktop, "awaitingSignIn")
	result := transaction{Version: 1, Profile: profile, Mode: o.Mode, ConfigID: entryID, Changes: []change{}}
	add := func(relative string, before document, value any, force bool) error {
		if !force && sameValue(before.value, value) {
			result.Guards = append(result.Guards, change{Relative: relative, Resolved: before.snapshot.Path, Existed: before.snapshot.Exists, Mode: uint32(before.snapshot.Mode.Perm()), Before: before.snapshot.Content})
			return nil
		}
		raw, e := encode(value)
		if e != nil {
			return e
		}
		if len(raw) > configsnapshot.MaxBytes {
			return fail("native_config_too_large")
		}
		result.Changes = append(result.Changes, change{Relative: relative, Resolved: before.snapshot.Path, Existed: before.snapshot.Exists, Mode: uint32(before.snapshot.Mode.Perm()), Before: before.snapshot.Content, After: raw})
		return nil
	}
	if oldID != "" {
		result.Guards = append(result.Guards, change{Relative: filepath.Join("configLibrary", oldID+".json"), Resolved: oldEntry.snapshot.Path, Existed: oldEntry.snapshot.Exists, Mode: uint32(oldEntry.snapshot.Mode.Perm()), Before: oldEntry.snapshot.Content})
	}
	if changedEntry {
		if err = add(filepath.Join("configLibrary", entryID+".json"), current, nextEntry, true); err != nil {
			return transaction{}, err
		}
	}
	if o.Mode == "api" {
		dev := clone(developer.value)
		dev["allowDevTools"] = true
		if err = add("developer_settings.json", developer, dev, false); err != nil {
			return transaction{}, err
		}
	}
	if err = add(filepath.Join("configLibrary", "_meta.json"), meta, nextMeta, false); err != nil {
		return transaction{}, err
	}
	if err = add("claude_desktop_config.json", desktop, nextDesktop, false); err != nil {
		return transaction{}, err
	}
	if err = add(stateName, owned, nextOwned, false); err != nil {
		return transaction{}, err
	}
	targets := map[string]string{}
	for _, item := range append(append([]change(nil), result.Changes...), result.Guards...) {
		if previous, exists := targets[item.Resolved]; exists && previous != item.Relative {
			return transaction{}, fail("desktop_configuration_target_alias")
		}
		targets[item.Resolved] = item.Relative
	}
	return result, nil
}

func validReceiptMode(mode string, managed map[string]any) bool {
	if mode == "web" {
		return len(managed) == 0
	}
	if managed["inferenceProvider"] != "gateway" || managed["inferenceCredentialKind"] != "helper-script" || managed["inferenceGatewayAuthScheme"] != "bearer" || managed["modelDiscoveryEnabled"] != true {
		return false
	}
	for _, key := range []string{"inferenceGatewayBaseUrl", "inferenceCredentialHelper"} {
		if text, ok := managed[key].(string); !ok || text == "" {
			return false
		}
	}
	for key := range managed {
		switch key {
		case "inferenceProvider", "inferenceCredentialKind", "inferenceGatewayBaseUrl", "inferenceGatewayAuthScheme", "inferenceCredentialHelper", "inferenceCredentialHelperArgs", "modelDiscoveryEnabled":
		default:
			return false
		}
	}
	if args, exists := managed["inferenceCredentialHelperArgs"]; exists {
		list, ok := args.([]any)
		if !ok {
			return false
		}
		for _, item := range list {
			if _, ok := item.(string); !ok {
				return false
			}
		}
	}
	return true
}
