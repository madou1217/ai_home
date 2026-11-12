package deletionprojection

import (
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
)

// TestProjectionSpecsCoverEveryProvider 是表驱动的守卫：
// 每个 Provider 要么有删除投影规格，要么在 node-only 名单里写明原因。
// 两者都没有、两者都有、或原因为空，都必须让测试失败，避免新增 Provider
// 时删除流程悄悄失败或悄悄走错分支。
func TestProjectionSpecsCoverEveryProvider(t *testing.T) {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatal(err)
	}
	known := make(map[string]bool)
	for _, definition := range catalog.List() {
		providerID := strings.TrimSpace(definition.ID)
		if providerID == "" {
			continue
		}
		known[providerID] = true
		_, hasSpec := projectionSpecFor(providerID)
		reason, nodeOnly := nodeOnlyDeletionReasons[providerID]
		switch {
		case hasSpec && nodeOnly:
			t.Errorf("%s 同时注册了投影规格和 node-only 原因，必须二选一", providerID)
		case !hasSpec && !nodeOnly:
			t.Errorf("%s 既没有投影规格，也不在 node-only 名单里", providerID)
		case nodeOnly && strings.TrimSpace(reason) == "":
			t.Errorf("%s 的 node-only 原因为空", providerID)
		}
	}
	for providerID := range projectionSpecs {
		if !known[providerID] {
			t.Errorf("投影规格里的 %s 不在 Provider 目录中", providerID)
		}
	}
	for providerID := range nodeOnlyDeletionReasons {
		if !known[providerID] {
			t.Errorf("node-only 名单里的 %s 不在 Provider 目录中", providerID)
		}
	}
}

// TestProjectionSpecsDeclareCredentialAndRoot 校验规格自身完整，避免新增
// Provider 时只填了半张表（有根没凭据，或有凭据没根）。
func TestProjectionSpecsDeclareCredentialAndRoot(t *testing.T) {
	for providerID, spec := range projectionSpecs {
		if len(spec.roots) == 0 {
			t.Errorf("%s 没有声明任何投影根", providerID)
			continue
		}
		// credentialNone 是显式的「删除时不采纳凭据」：它不应该再声明待采纳文件，
		// 否则规格和实现会表达两个相反的意图。
		if spec.credential.mode == credentialNone {
			if len(spec.credential.artifacts) != 0 {
				t.Errorf("%s 声明了不采纳凭据却仍列出 artifact", providerID)
			}
		} else if len(spec.credential.artifacts) == 0 {
			t.Errorf("%s 没有声明任何凭据 artifact", providerID)
			continue
		}
		if _, found := credentialReconcilers[spec.credential.mode]; !found {
			t.Errorf("%s 的凭据模式 %d 没有实现", providerID, spec.credential.mode)
		}
		for kind, rootSpec := range spec.roots {
			// 整根私有表示没有任何条目会迁移到宿主；再声明映射会自相矛盾。
			if rootSpec.privateRoot && len(rootSpec.resourceMappings) != 0 {
				t.Errorf("%s 的投影根 %d 同时声明整根私有和资源映射", providerID, kind)
			}
			// 整根私有已覆盖全部条目，再列 privateArtifacts 只会让人误以为
			// 存在不随投影删除的路径。
			if rootSpec.privateRoot && len(rootSpec.privateArtifacts) != 0 {
				t.Errorf("%s 的投影根 %d 整根私有却仍声明私有路径", providerID, kind)
			}
		}
		for _, artifact := range spec.credential.artifacts {
			if _, found := spec.roots[artifact.rootKind]; !found {
				t.Errorf("%s 的凭据 artifact 指向未声明的投影根 %d", providerID, artifact.rootKind)
			}
			if len(artifact.segments) == 0 {
				t.Errorf("%s 的凭据 artifact 路径为空", providerID)
			}
			if spec.credential.mode == credentialNativeGeneration && strings.TrimSpace(artifact.field) == "" {
				t.Errorf("%s 的 native 凭据 artifact 缺少 envelope 字段", providerID)
			}
		}
	}
}

// TestPureFileSystemProviderBatchRegistration 固定纯文件系统 Provider 的接入边界：
// cline/opencode/qoder/qodercn 已注册规格，不能同时留在 node-only 名单。
func TestPureFileSystemProviderBatchRegistration(t *testing.T) {
	for _, providerID := range []string{
		providerCline, providerOpencode, providerQoder, providerQoderCN,
	} {
		if _, found := projectionSpecFor(providerID); !found {
			t.Errorf("%s 应注册删除投影规格", providerID)
		}
		if reason, nodeOnly := nodeOnlyDeletionReasons[providerID]; nodeOnly {
			t.Errorf("%s 已接入 Go，却仍在 node-only 名单: %s", providerID, reason)
		}
	}
}

// TestDeletionOnlyProviderBatchRegistration 固定本批「只删投影、不 adopt 凭据」
// 的边界：家族四支与 kimi 已注册整根私有规格，不能同时留在 node-only 名单。
func TestDeletionOnlyProviderBatchRegistration(t *testing.T) {
	for _, providerID := range []string{
		providerCodebuddy, providerCodebuddyCN, providerWorkbuddy, providerWorkbuddyCN, providerKimi,
	} {
		spec, found := projectionSpecFor(providerID)
		if !found {
			t.Errorf("%s 应注册删除投影规格", providerID)
			continue
		}
		if reason, nodeOnly := nodeOnlyDeletionReasons[providerID]; nodeOnly {
			t.Errorf("%s 已接入 Go，却仍在 node-only 名单: %s", providerID, reason)
		}
		rootSpec, found := spec.roots[projectionKindAccount]
		if !found || !rootSpec.privateRoot {
			t.Errorf("%s 的账号投影应整根私有", providerID)
		}
		if spec.credential.mode != credentialNone {
			t.Errorf("%s 的凭据模式 = %d, want credentialNone", providerID, spec.credential.mode)
		}
	}
}

// TestKiroDeletionRegistration 固定 kiro 的接入边界：投影整根私有，
// data.sqlite3 走独立的 SQLite 凭据模式，且不能再留在 node-only 名单。
func TestKiroDeletionRegistration(t *testing.T) {
	spec, found := projectionSpecFor(providerKiro)
	if !found {
		t.Fatal("kiro 应注册删除投影规格")
	}
	if reason, nodeOnly := nodeOnlyDeletionReasons[providerKiro]; nodeOnly {
		t.Fatalf("kiro 已接入 Go，却仍在 node-only 名单: %s", reason)
	}
	rootSpec, found := spec.roots[projectionKindAccount]
	if !found || !rootSpec.privateRoot {
		t.Fatal("kiro 的账号投影应整根私有")
	}
	if spec.credential.mode != credentialKiroSQLite {
		t.Fatalf("kiro 的凭据模式 = %d, want credentialKiroSQLite", spec.credential.mode)
	}
	if len(spec.credential.artifacts) != 1 ||
		!segmentsEqual(spec.credential.artifacts[0].segments, []string{"data.sqlite3"}) {
		t.Fatalf("kiro 的凭据 artifact 应唯一指向 data.sqlite3: %+v", spec.credential.artifacts)
	}
}

// TestNodeOnlyDeletionReasonsNameConcreteGaps 要求留在 Node 的 Provider 写清
// 具体缺口：泛泛的「删除仍由 Node 处理」无法让后来的人判断何时可以迁过来。
func TestNodeOnlyDeletionReasonsNameConcreteGaps(t *testing.T) {
	cases := map[string][]string{
		"zcode": {"enc:v1", "桥", "影子"},
	}
	for providerID, keywords := range cases {
		reason, found := nodeOnlyDeletionReasons[providerID]
		if !found {
			t.Errorf("%s 必须留在 node-only 名单", providerID)
			continue
		}
		for _, keyword := range keywords {
			if !strings.Contains(reason, keyword) {
				t.Errorf("%s 的 node-only 原因缺少 %q，实际 %q", providerID, keyword, reason)
			}
		}
	}
}

// agy 的投影必须整根私有且删除时不采纳凭据（暖机会话由 Node 删除路由驱逐）。
func TestAgyProjectionIsPrivateRootWithoutCredentialAdoption(t *testing.T) {
	spec, found := projectionSpecFor(providerAgy)
	if !found {
		t.Fatal("agy 缺少投影删除规格")
	}
	if !spec.roots[projectionKindAccount].privateRoot {
		t.Fatal("agy 的账号投影应整根私有")
	}
	if spec.credential.mode != credentialNone {
		t.Fatalf("agy 的凭据模式 = %d, want credentialNone", spec.credential.mode)
	}
}

// TestCredentialArtifactsArePrivateProjectionPaths 是「多落点」守卫：
// 每个凭据 artifact 必须也被同一投影根的私有路径覆盖。漏一条，删除时
// 它就会被当成 Provider 资源迁回宿主，或者留在投影里形成残留凭据。
func TestCredentialArtifactsArePrivateProjectionPaths(t *testing.T) {
	for providerID, spec := range projectionSpecs {
		for _, artifact := range spec.credential.artifacts {
			rootSpec := spec.roots[artifact.rootKind]
			// 整根私有已经覆盖根下所有条目，包括凭据 artifact 本身。
			if rootSpec.privateRoot {
				continue
			}
			if classifyPrivatePath(artifact.segments, rootSpec.privateArtifacts) != projectionEntryPrivate {
				t.Errorf(
					"%s 的凭据 artifact %s 未被私有路径覆盖",
					providerID,
					strings.Join(artifact.segments, "/"),
				)
			}
		}
	}
}
