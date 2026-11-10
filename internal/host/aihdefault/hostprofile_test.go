package aihdefault

import (
	"os"
	"path/filepath"
	"testing"
)

func testTarget(t *testing.T) Target {
	t.Helper()
	return Target{Directory: t.TempDir(), FileName: "settings.json"}
}

func mustActivate(t *testing.T, target Target, content string) ActivateResult {
	t.Helper()
	result, err := ActivateProfile(target, func(string, bool) (string, error) { return content, nil })
	if err != nil {
		t.Fatalf("ActivateProfile() error = %v", err)
	}
	return result
}

func mustReadFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%s) error = %v", path, err)
	}
	return string(raw)
}

// TestActivateCreatesManagedState 落点写配置 + 状态，且文件是私有的。
func TestActivateCreatesManagedState(t *testing.T) {
	target := testTarget(t)
	result := mustActivate(t, target, "{\n  \"managed\": true\n}\n")
	if result.Takeover != nil {
		t.Fatalf("unexpected takeover = %+v", result.Takeover)
	}
	configPath := filepath.Join(target.Directory, target.FileName)
	if got := mustReadFile(t, configPath); got != "{\n  \"managed\": true\n}\n" {
		t.Fatalf("config = %q", got)
	}
	info, err := os.Stat(configPath)
	if err != nil {
		t.Fatalf("Stat() error = %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("config perm = %o", perm)
	}
	state, err := readManagedState(filepath.Join(target.Directory, ManagedStateFileName), target.FileName)
	if err != nil {
		t.Fatalf("readManagedState() error = %v", err)
	}
	if state == nil || !state.Active || state.OriginalExisted || state.Original != "" ||
		state.ManagedHash != contentHash("{\n  \"managed\": true\n}\n") {
		t.Fatalf("state = %+v", state)
	}
}

// TestDeactivateRemovesFreshFile 原本没有该文件时，还原就是删除。
func TestDeactivateRemovesFreshFile(t *testing.T) {
	target := testTarget(t)
	mustActivate(t, target, "{}\n")
	result, err := DeactivateProfile(target)
	if err != nil {
		t.Fatalf("DeactivateProfile() error = %v", err)
	}
	if !result.Restored {
		t.Fatal("DeactivateProfile() did not restore")
	}
	if _, err := os.Stat(filepath.Join(target.Directory, target.FileName)); !os.IsNotExist(err) {
		t.Fatalf("config still present, err = %v", err)
	}
	state, err := readManagedState(filepath.Join(target.Directory, ManagedStateFileName), target.FileName)
	if err != nil || state == nil || state.Active {
		t.Fatalf("state = %+v, err = %v", state, err)
	}
}

// TestDeactivateRestoresOriginalBytes 接管前的文件内容原样写回。
func TestDeactivateRestoresOriginalBytes(t *testing.T) {
	target := testTarget(t)
	configPath := filepath.Join(target.Directory, target.FileName)
	if err := os.WriteFile(configPath, []byte("{\n  \"user\": true\n}\n"), 0o600); err != nil {
		t.Fatalf("seed config error = %v", err)
	}
	mustActivate(t, target, "{}\n")
	if _, err := DeactivateProfile(target); err != nil {
		t.Fatalf("DeactivateProfile() error = %v", err)
	}
	if got := mustReadFile(t, configPath); got != "{\n  \"user\": true\n}\n" {
		t.Fatalf("restored config = %q", got)
	}
}

// TestActivateFailsClosedOnExternalEdit 无接管时外部改动必须失败，且不调用 build。
func TestActivateFailsClosedOnExternalEdit(t *testing.T) {
	target := testTarget(t)
	mustActivate(t, target, "{}\n")
	configPath := filepath.Join(target.Directory, target.FileName)
	if err := os.WriteFile(configPath, []byte("user edit\n"), 0o600); err != nil {
		t.Fatalf("edit config error = %v", err)
	}
	built := false
	_, err := ActivateProfile(target, func(string, bool) (string, error) {
		built = true
		return "next\n", nil
	})
	if CodeOf(err) != CodeHostConfigChanged {
		t.Fatalf("ActivateProfile() error = %v", err)
	}
	if built {
		t.Fatal("build ran despite failed ownership check")
	}
	if got := mustReadFile(t, configPath); got != "user edit\n" {
		t.Fatalf("config changed = %q", got)
	}
}

// TestActivateAdoptsExternalBaseline 手改内容不像 AIH 网关注入时成为新基线。
func TestActivateAdoptsExternalBaseline(t *testing.T) {
	target := testTarget(t)
	mustActivate(t, target, "{}\n")
	configPath := filepath.Join(target.Directory, target.FileName)
	if err := os.WriteFile(configPath, []byte("user edit\n"), 0o600); err != nil {
		t.Fatalf("edit config error = %v", err)
	}
	target.Takeover = &Takeover{GatewayURLs: []string{"http://127.0.0.1:9527/v1"}}
	result := mustActivate(t, target, "gateway\n")
	if result.Takeover == nil || !result.Takeover.ExternallyChanged || !result.Takeover.AdoptedAsBaseline {
		t.Fatalf("takeover = %+v", result.Takeover)
	}
	if _, err := DeactivateProfile(target); err != nil {
		t.Fatalf("DeactivateProfile() error = %v", err)
	}
	if got := mustReadFile(t, configPath); got != "user edit\n" {
		t.Fatalf("adopted baseline not restored = %q", got)
	}
}

// TestActivateKeepsBaselineWhenEditLooksManaged 残留网关痕迹时沿用旧基线。
func TestActivateKeepsBaselineWhenEditLooksManaged(t *testing.T) {
	target := testTarget(t)
	configPath := filepath.Join(target.Directory, target.FileName)
	if err := os.WriteFile(configPath, []byte("original\n"), 0o600); err != nil {
		t.Fatalf("seed config error = %v", err)
	}
	mustActivate(t, target, "gateway\n")
	target.Takeover = &Takeover{GatewayURLs: []string{"http://127.0.0.1:9527/v1"}}
	if err := os.WriteFile(configPath, []byte("gateway\n# edited\nhttp://127.0.0.1:9527/v1\n"), 0o600); err != nil {
		t.Fatalf("edit config error = %v", err)
	}
	result := mustActivate(t, target, "gateway 2\n")
	if result.Takeover == nil || result.Takeover.AdoptedAsBaseline {
		t.Fatalf("takeover = %+v", result.Takeover)
	}
	if _, err := DeactivateProfile(target); err != nil {
		t.Fatalf("DeactivateProfile() error = %v", err)
	}
	if got := mustReadFile(t, configPath); got != "original\n" {
		t.Fatalf("restored config = %q", got)
	}
}

// TestCorruptStateRequiresTakeover 状态损坏时只有显式命令可以重建基线。
func TestCorruptStateRequiresTakeover(t *testing.T) {
	target := testTarget(t)
	statePath := filepath.Join(target.Directory, ManagedStateFileName)
	if err := os.WriteFile(statePath, []byte("{broken"), 0o600); err != nil {
		t.Fatalf("seed state error = %v", err)
	}
	if _, err := ActivateProfile(target, func(string, bool) (string, error) { return "{}\n", nil }); CodeOf(err) != CodeInvalidState {
		t.Fatalf("ActivateProfile() error = %v", err)
	}
	target.Takeover = &Takeover{}
	result, err := ActivateProfile(target, func(string, bool) (string, error) { return "{}\n", nil })
	if err != nil {
		t.Fatalf("ActivateProfile() error = %v", err)
	}
	if result.Takeover == nil || !result.Takeover.StateReset || !result.Takeover.AdoptedAsBaseline {
		t.Fatalf("takeover = %+v", result.Takeover)
	}
}

// TestActivateRejectsSymlinkTarget 符号链接不能被当成宿主配置写穿。
func TestActivateRejectsSymlinkTarget(t *testing.T) {
	target := testTarget(t)
	elsewhere := filepath.Join(t.TempDir(), "elsewhere.json")
	if err := os.WriteFile(elsewhere, []byte("real\n"), 0o600); err != nil {
		t.Fatalf("seed error = %v", err)
	}
	if err := os.Symlink(elsewhere, filepath.Join(target.Directory, target.FileName)); err != nil {
		t.Fatalf("Symlink() error = %v", err)
	}
	if _, err := ActivateProfile(target, func(string, bool) (string, error) { return "{}\n", nil }); CodeOf(err) != CodeHostConfigNotRegularFile {
		t.Fatalf("ActivateProfile() error = %v", err)
	}
	if got := mustReadFile(t, elsewhere); got != "real\n" {
		t.Fatalf("symlink target rewritten = %q", got)
	}
}

// TestOwnershipOutsideFileIsRejected claude-env 等策略仍留在 Node，Go 明确拒绝。
func TestOwnershipOutsideFileIsRejected(t *testing.T) {
	target := testTarget(t)
	target.Ownership = "claude-env"
	if _, err := ActivateProfile(target, func(string, bool) (string, error) { return "{}\n", nil }); CodeOf(err) != CodeOwnershipUnsupported {
		t.Fatalf("ActivateProfile() error = %v", err)
	}
	target = testTarget(t)
	statePath := filepath.Join(target.Directory, ManagedStateFileName)
	state := ManagedState{
		FileName:    target.FileName,
		Active:      true,
		Ownership:   "claude-env",
		ManagedHash: contentHash("{}"),
	}
	if err := writePrivateJSON(statePath, state); err != nil {
		t.Fatalf("writePrivateJSON() error = %v", err)
	}
	target.Takeover = &Takeover{}
	if _, err := ActivateProfile(target, func(string, bool) (string, error) { return "{}\n", nil }); CodeOf(err) != CodeOwnershipUnsupported {
		t.Fatalf("ActivateProfile() error = %v", err)
	}
}

// TestDeactivateWithoutStateIsNoop 没有受管状态时不做任何写入。
func TestDeactivateWithoutStateIsNoop(t *testing.T) {
	target := testTarget(t)
	result, err := DeactivateProfile(target)
	if err != nil {
		t.Fatalf("DeactivateProfile() error = %v", err)
	}
	if result.Restored {
		t.Fatal("DeactivateProfile() restored without state")
	}
	if _, err := os.Stat(filepath.Join(target.Directory, target.FileName)); !os.IsNotExist(err) {
		t.Fatalf("config created, err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(target.Directory, ManagedStateFileName)); !os.IsNotExist(err) {
		t.Fatalf("state created, err = %v", err)
	}
}

// TestBuildErrorLeavesFilesUntouched build 失败时状态与配置都不落盘。
func TestBuildErrorLeavesFilesUntouched(t *testing.T) {
	target := testTarget(t)
	if _, err := ActivateProfile(target, func(string, bool) (string, error) { return "", os.ErrInvalid }); err == nil {
		t.Fatal("ActivateProfile() swallowed build error")
	}
	if _, err := os.Stat(filepath.Join(target.Directory, ManagedStateFileName)); !os.IsNotExist(err) {
		t.Fatalf("state created, err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(target.Directory, target.FileName)); !os.IsNotExist(err) {
		t.Fatalf("config created, err = %v", err)
	}
}

// TestVerifyProfileDetectsExternalEdit 还原前的归属校验只看不写。
func TestVerifyProfileDetectsExternalEdit(t *testing.T) {
	target := testTarget(t)
	mustActivate(t, target, "{}\n")
	if err := VerifyProfile(target); err != nil {
		t.Fatalf("VerifyProfile() error = %v", err)
	}
	configPath := filepath.Join(target.Directory, target.FileName)
	if err := os.WriteFile(configPath, []byte("user edit\n"), 0o600); err != nil {
		t.Fatalf("edit config error = %v", err)
	}
	if err := VerifyProfile(target); CodeOf(err) != CodeHostConfigChanged {
		t.Fatalf("VerifyProfile() error = %v", err)
	}
}
