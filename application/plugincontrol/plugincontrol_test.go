package plugincontrol_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/plugincontrol"
	"github.com/madou1217/ai_home/internal/adapters/pluginstatestore"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

type fakeAcceptor struct {
	pluginID string
	version  string
	digest   string
	rootDir  string
}

func (acceptor *fakeAcceptor) Accept(_ string, _ plugincontrol.AcceptOptions) (plugincontrol.AcceptedArtifact, error) {
	pluginsRoot := filepath.Join(acceptor.rootDir, "plugins")
	artifact := filepath.Join(pluginsRoot, "accepted", acceptor.digest+".aih-plugin")
	directory := filepath.Join(pluginsRoot, "extracted", acceptor.digest)
	if err := os.MkdirAll(filepath.Dir(artifact), 0o700); err != nil {
		return plugincontrol.AcceptedArtifact{}, err
	}
	if err := os.WriteFile(artifact, []byte("artifact"), 0o600); err != nil {
		return plugincontrol.AcceptedArtifact{}, err
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return plugincontrol.AcceptedArtifact{}, err
	}
	if err := os.WriteFile(filepath.Join(directory, "index.mjs"), []byte("export {};\n"), 0o600); err != nil {
		return plugincontrol.AcceptedArtifact{}, err
	}
	manifest := map[string]any{
		"pluginId": acceptor.pluginID,
		"version":  acceptor.version,
		"entry":    "index.mjs",
		"permissions": map[string]any{
			"network":     []any{},
			"filesystem":  map[string]any{"read": []any{}, "write": []any{}},
			"secrets":     []any{},
			"environment": []any{},
		},
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		return plugincontrol.AcceptedArtifact{}, err
	}
	return plugincontrol.AcceptedArtifact{
		Digest:                 acceptor.digest,
		ArtifactPath:           artifact,
		Directory:              directory,
		Manifest:               encoded,
		ManifestValue:          manifest,
		Signature:              plugincontrol.Signature{Status: "unsigned"},
		PermissionsFingerprint: "fingerprint-" + acceptor.digest,
	}, nil
}

func newTestInstaller(t *testing.T) (*plugincontrol.Installer, *pluginstatestore.Store, string) {
	t.Helper()
	home := t.TempDir()
	store, err := pluginstatestore.NewStore(home)
	if err != nil {
		t.Fatalf("创建状态存储失败: %v", err)
	}
	acceptor := &fakeAcceptor{pluginID: "aih.test.echo", version: "1.0.0", digest: "digest-one"}
	acceptor.rootDir = home
	installer, err := plugincontrol.NewInstaller(home, acceptor, store)
	if err != nil {
		t.Fatalf("创建安装器失败: %v", err)
	}
	return installer, store, home
}

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("期望错误 %s，实际成功", code)
	}
	coded, ok := pluginerr.From(err)
	if !ok || coded.Code != code {
		t.Fatalf("错误 = %v, want %s", err, code)
	}
}

func readState(t *testing.T, store *pluginstatestore.Store) plugincontrol.State {
	t.Helper()
	var captured plugincontrol.State
	_, err := store.Update(context.Background(), func(state *plugincontrol.State) error {
		captured = state.Clone()
		return nil
	}, nil)
	if err != nil {
		t.Fatalf("读取状态失败: %v", err)
	}
	return captured
}

func TestInstallWritesNodeCompatibleRecord(t *testing.T) {
	installer, store, home := newTestInstaller(t)
	result, err := installer.Install(context.Background(), "/tmp/ignored.aih-plugin", plugincontrol.AcceptOptions{})
	if err != nil {
		t.Fatalf("安装失败: %v", err)
	}
	if result.PluginID != "aih.test.echo" || result.Version != "1.0.0" || result.Digest != "digest-one" || result.Revision != 1 {
		t.Fatalf("安装结果不符: %+v", result)
	}
	if result.Signature.Status != "unsigned" || len(result.Permissions) == 0 {
		t.Fatalf("签名/权限响应不符: %+v", result)
	}
	state := readState(t, store) // 注意：这次读取会再递增 revision，只用于取记录内容
	if len(state.Installed) != 1 {
		t.Fatalf("installed 记录数 = %d", len(state.Installed))
	}
	var record map[string]any
	if err := json.Unmarshal(state.Installed[0], &record); err != nil {
		t.Fatalf("记录不是合法 JSON: %v", err)
	}
	for _, key := range []string{"pluginId", "version", "digest", "artifact", "directory", "manifest", "installedAt", "signature", "permissionsFingerprint"} {
		if _, present := record[key]; !present {
			t.Fatalf("记录缺少字段 %s: %s", key, state.Installed[0])
		}
	}
	if record["permissionsFingerprint"] != "fingerprint-digest-one" {
		t.Fatalf("permissionsFingerprint 不符: %v", record["permissionsFingerprint"])
	}
	artifact := filepath.Join(home, "plugins", "accepted", "digest-one.aih-plugin")
	if _, err := os.Stat(artifact); err != nil {
		t.Fatalf("制品未落盘: %v", err)
	}
}

func TestInstallSameDigestIsIdempotent(t *testing.T) {
	installer, store, _ := newTestInstaller(t)
	if _, err := installer.Install(context.Background(), "/tmp/x", plugincontrol.AcceptOptions{}); err != nil {
		t.Fatalf("首次安装失败: %v", err)
	}
	second, err := installer.Install(context.Background(), "/tmp/x", plugincontrol.AcceptOptions{})
	if err != nil {
		t.Fatalf("重复安装失败: %v", err)
	}
	if second.Revision != 2 {
		t.Fatalf("重复安装也递增 revision: %+v", second)
	}
	state := readState(t, store)
	if len(state.Installed) != 1 {
		t.Fatalf("同 digest 应保持一条记录: %d", len(state.Installed))
	}
}

func TestInstallDifferentDigestConflicts(t *testing.T) {
	installer, store, home := newTestInstaller(t)
	if _, err := installer.Install(context.Background(), "/tmp/x", plugincontrol.AcceptOptions{}); err != nil {
		t.Fatalf("首次安装失败: %v", err)
	}
	conflicting := &fakeAcceptor{pluginID: "aih.test.echo", version: "1.0.0", digest: "digest-two", rootDir: home}
	conflictInstaller, err := plugincontrol.NewInstaller(home, conflicting, store)
	if err != nil {
		t.Fatalf("创建安装器失败: %v", err)
	}
	_, err = conflictInstaller.Install(context.Background(), "/tmp/x", plugincontrol.AcceptOptions{})
	requireCode(t, err, plugincontrol.CodeVersionConflict)
	state := readState(t, store)
	if len(state.Installed) != 1 {
		t.Fatalf("冲突后记录数 = %d", len(state.Installed))
	}
}

func TestUninstallRejectsInUseAndCleansFiles(t *testing.T) {
	installer, store, home := newTestInstaller(t)
	if _, err := installer.Install(context.Background(), "/tmp/x", plugincontrol.AcceptOptions{}); err != nil {
		t.Fatalf("安装失败: %v", err)
	}
	if _, err := store.Update(context.Background(), func(state *plugincontrol.State) error {
		state.Instances = append(state.Instances, json.RawMessage("{\"instanceId\":\"echo\",\"pluginId\":\"aih.test.echo\",\"version\":\"1.0.0\",\"enabled\":true}"))
		return nil
	}, nil); err != nil {
		t.Fatalf("写入实例失败: %v", err)
	}
	_, err := installer.Uninstall(context.Background(), plugincontrol.UninstallInput{PluginID: "aih.test.echo", Version: "1.0.0"})
	requireCode(t, err, plugincontrol.CodeInUse)
	artifact := filepath.Join(home, "plugins", "accepted", "digest-one.aih-plugin")
	if _, statErr := os.Stat(artifact); statErr != nil {
		t.Fatalf("in-use 拒绝后制品不应被删除: %v", statErr)
	}
	if _, err := store.Update(context.Background(), func(state *plugincontrol.State) error {
		state.Instances = []json.RawMessage{}
		return nil
	}, nil); err != nil {
		t.Fatalf("移除实例失败: %v", err)
	}
	result, err := installer.Uninstall(context.Background(), plugincontrol.UninstallInput{PluginID: "aih.test.echo", Version: "1.0.0"})
	if err != nil {
		t.Fatalf("卸载失败: %v", err)
	}
	if result.PluginID != "aih.test.echo" || result.Version != "1.0.0" {
		t.Fatalf("卸载结果不符: %+v", result)
	}
	if _, statErr := os.Stat(artifact); !os.IsNotExist(statErr) {
		t.Fatalf("卸载后制品应删除: %v", statErr)
	}
	if _, statErr := os.Stat(filepath.Join(home, "plugins", "extracted", "digest-one")); !os.IsNotExist(statErr) {
		t.Fatalf("卸载后解压目录应删除: %v", statErr)
	}
	state := readState(t, store)
	if len(state.Installed) != 0 {
		t.Fatalf("卸载后仍有记录: %d", len(state.Installed))
	}
}

func TestUninstallKeepsSharedDigestFiles(t *testing.T) {
	installer, store, home := newTestInstaller(t)
	if _, err := installer.Install(context.Background(), "/tmp/x", plugincontrol.AcceptOptions{}); err != nil {
		t.Fatalf("安装失败: %v", err)
	}
	// 手工追加同 digest 的另一条记录（防御性：同一制品被两条记录引用）。
	if _, err := store.Update(context.Background(), func(state *plugincontrol.State) error {
		state.Installed = append(state.Installed, json.RawMessage("{\"pluginId\":\"aih.test.echo\",\"version\":\"2.0.0\",\"digest\":\"digest-one\",\"artifact\":\""+filepath.Join(home, "plugins", "accepted", "digest-one.aih-plugin")+"\",\"directory\":\""+filepath.Join(home, "plugins", "extracted", "digest-one")+"\"}"))
		return nil
	}, nil); err != nil {
		t.Fatalf("追加记录失败: %v", err)
	}
	if _, err := installer.Uninstall(context.Background(), plugincontrol.UninstallInput{PluginID: "aih.test.echo", Version: "1.0.0"}); err != nil {
		t.Fatalf("卸载失败: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, "plugins", "accepted", "digest-one.aih-plugin")); err != nil {
		t.Fatalf("仍有记录引用 digest 时不应删除制品: %v", err)
	}
}

func TestUninstallCASAndLookupErrors(t *testing.T) {
	installer, _, _ := newTestInstaller(t)
	if _, err := installer.Install(context.Background(), "/tmp/x", plugincontrol.AcceptOptions{}); err != nil {
		t.Fatalf("安装失败: %v", err)
	}
	wrong := int64(99)
	_, err := installer.Uninstall(context.Background(), plugincontrol.UninstallInput{PluginID: "aih.test.echo", ExpectedRevision: &wrong})
	requireCode(t, err, plugincontrol.CodeRevisionConflict)
	_, err = installer.Uninstall(context.Background(), plugincontrol.UninstallInput{PluginID: "missing"})
	requireCode(t, err, plugincontrol.CodeNotInstalled)
}

func TestUninstallAmbiguousVersion(t *testing.T) {
	installer, store, home := newTestInstaller(t)
	if _, err := store.Update(context.Background(), func(state *plugincontrol.State) error {
		state.Installed = append(state.Installed,
			json.RawMessage("{\"pluginId\":\"aih.test.echo\",\"version\":\"1.0.0\",\"digest\":\"a\"}"),
			json.RawMessage("{\"pluginId\":\"aih.test.echo\",\"version\":\"2.0.0\",\"digest\":\"b\"}"),
		)
		return nil
	}, nil); err != nil {
		t.Fatalf("写入记录失败: %v", err)
	}
	_, err := installer.Uninstall(context.Background(), plugincontrol.UninstallInput{PluginID: "aih.test.echo"})
	requireCode(t, err, plugincontrol.CodeVersionAmbiguous)
	_ = home
}

func TestUninstallNeverDeletesOutsidePluginRoot(t *testing.T) {
	installer, store, home := newTestInstaller(t)
	outside := filepath.Join(home, "outside.txt")
	if err := os.WriteFile(outside, []byte("keep"), 0o600); err != nil {
		t.Fatalf("创建外部文件失败: %v", err)
	}
	if _, err := store.Update(context.Background(), func(state *plugincontrol.State) error {
		state.Installed = append(state.Installed, json.RawMessage("{\"pluginId\":\"evil\",\"version\":\"1.0.0\",\"digest\":\"evil\",\"artifact\":\""+outside+"\",\"directory\":\""+outside+"\"}"))
		return nil
	}, nil); err != nil {
		t.Fatalf("写入记录失败: %v", err)
	}
	if _, err := installer.Uninstall(context.Background(), plugincontrol.UninstallInput{PluginID: "evil", Version: "1.0.0"}); err != nil {
		t.Fatalf("卸载失败: %v", err)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("越界路径不得被删除: %v", err)
	}
	_ = strings.TrimSpace("")
}
