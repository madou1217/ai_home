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
		if len(spec.credential.artifacts) == 0 {
			t.Errorf("%s 没有声明任何凭据 artifact", providerID)
			continue
		}
		if _, found := credentialReconcilers[spec.credential.mode]; !found {
			t.Errorf("%s 的凭据模式 %d 没有实现", providerID, spec.credential.mode)
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
