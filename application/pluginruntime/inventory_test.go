package pluginruntime

import (
	"encoding/json"
	"reflect"
	"sort"
	"testing"
)

type fakeProjections struct {
	snapshots []Projection
}

func (fake fakeProjections) Snapshots() []Projection { return fake.snapshots }

func projectionOf(generation int64, contributions ...Contribution) Projection {
	return Projection{Generation: generation, Contributions: contributions}
}

func echoContribution(instanceID string) Contribution {
	return Contribution{ID: "echo.reply", Capability: "gateway.request", Order: 0, FailurePolicy: "deny", InstanceID: instanceID}
}

func echoInstalled() InstalledRecord {
	return InstalledRecord{
		PluginID: "echo",
		Version:  "1.0.0",
		Digest:   "sha256:abc",
		Manifest: Manifest{PluginID: "echo", Version: "1.0.0", Contributes: []Contribution{echoContribution("echo")}},
	}
}

func echoInstance(enabled bool) InstanceRecord {
	return InstanceRecord{InstanceID: "echo", PluginID: "echo", Version: "1.0.0", Enabled: enabled, UpdatedAt: 10}
}

func issueCodes(inventory Inventory) []string {
	codes := make([]string, 0, len(inventory.Consistency.Issues))
	for _, issue := range inventory.Consistency.Issues {
		codes = append(codes, issue.Code)
	}
	sort.Strings(codes)
	return codes
}

func runtimeStatus(inventory Inventory, instanceID string) string {
	for _, instance := range inventory.Runtime.Instances {
		if instance.InstanceID == instanceID {
			return instance.Status
		}
	}
	return ""
}

// TestBuildInventory 覆盖空目录、启停、未知插件与投影一致性四类事实组合。
func TestBuildInventory(t *testing.T) {
	tests := []struct {
		name       string
		state      ControlState
		live       LiveProjections
		wantCodes  []string
		wantStatus map[string]string
		check      func(t *testing.T, inventory Inventory)
	}{
		{
			name:      "空目录",
			state:     ControlState{},
			live:      fakeProjections{},
			wantCodes: []string{},
			check: func(t *testing.T, inventory Inventory) {
				t.Helper()
				if inventory.Revision != 0 || inventory.Runtime.ActiveGeneration != 0 {
					t.Fatalf("空目录应无 revision 与代次: %+v", inventory)
				}
				if inventory.Installed == nil || inventory.Instances == nil ||
					inventory.Runtime.Generations == nil || inventory.Runtime.Instances == nil {
					t.Fatalf("空数组不能是 null: %+v", inventory)
				}
			},
		},
		{
			name:       "启用且投影一致",
			state:      ControlState{Revision: 2, Installed: []InstalledRecord{echoInstalled()}, Instances: []InstanceRecord{echoInstance(true)}},
			live:       fakeProjections{snapshots: []Projection{projectionOf(3, echoContribution("echo"))}},
			wantCodes:  []string{},
			wantStatus: map[string]string{"echo": InstanceStatusProjected},
			check: func(t *testing.T, inventory Inventory) {
				t.Helper()
				if inventory.Revision != 2 || inventory.Runtime.ActiveGeneration != 3 {
					t.Fatalf("revision/代次未透传: %+v", inventory)
				}
				if inventory.Runtime.Generations == nil || len(inventory.Runtime.Generations) != 1 {
					t.Fatalf("代次列表不符: %+v", inventory.Runtime)
				}
				if len(inventory.Runtime.Contributions) != 1 || inventory.Runtime.Contributions[0].Generation != 3 {
					t.Fatalf("贡献项投影不符: %+v", inventory.Runtime.Contributions)
				}
			},
		},
		{
			name:       "停用但仍被投影",
			state:      ControlState{Revision: 2, Installed: []InstalledRecord{echoInstalled()}, Instances: []InstanceRecord{echoInstance(false)}},
			live:       fakeProjections{snapshots: []Projection{projectionOf(3, echoContribution("echo"))}},
			wantCodes:  []string{IssueProjectionOrphan},
			wantStatus: map[string]string{"echo": InstanceStatusProjected},
			check: func(t *testing.T, inventory Inventory) {
				t.Helper()
				if inventory.Instances[0].Enabled {
					t.Fatal("实例应显示为停用")
				}
			},
		},
		{
			name:       "启用但未投影",
			state:      ControlState{Revision: 1, Installed: []InstalledRecord{echoInstalled()}, Instances: []InstanceRecord{echoInstance(true)}},
			live:       fakeProjections{},
			wantCodes:  []string{IssueInstanceNotProjected},
			wantStatus: map[string]string{"echo": InstanceStatusAbsent},
		},
		{
			name:       "未知插件",
			state:      ControlState{Revision: 1, Instances: []InstanceRecord{{InstanceID: "ghost", PluginID: "ghost", Version: "9.9.9", Enabled: true}}},
			live:       fakeProjections{},
			wantCodes:  []string{IssueInstanceArtifactMissing},
			wantStatus: map[string]string{"ghost": InstanceStatusAbsent},
		},
		{
			name:  "旧代次排空",
			state: ControlState{Revision: 4, Installed: []InstalledRecord{echoInstalled()}, Instances: []InstanceRecord{echoInstance(true)}},
			live: fakeProjections{snapshots: []Projection{
				projectionOf(2, echoContribution("echo")),
				projectionOf(3),
			}},
			wantCodes:  []string{IssueInstanceNotProjected},
			wantStatus: map[string]string{"echo": InstanceStatusRetiring},
			check: func(t *testing.T, inventory Inventory) {
				t.Helper()
				if !reflect.DeepEqual(inventory.Runtime.RetiringGenerations, []int64{2}) {
					t.Fatalf("排空代次不符: %+v", inventory.Runtime)
				}
			},
		},
		{
			name:      "清单外贡献项",
			state:     ControlState{Revision: 2, Installed: []InstalledRecord{echoInstalled()}, Instances: []InstanceRecord{echoInstance(true)}},
			live:      fakeProjections{snapshots: []Projection{projectionOf(3, echoContribution("echo"), Contribution{ID: "echo.extra", Capability: "gateway.request", FailurePolicy: "deny", InstanceID: "echo"})}},
			wantCodes: []string{IssueInstanceContributionDelta},
		},
		{
			name:  "重复实例",
			state: ControlState{Revision: 2, Installed: []InstalledRecord{echoInstalled()}, Instances: []InstanceRecord{echoInstance(true), echoInstance(true)}},
			live:  fakeProjections{snapshots: []Projection{projectionOf(3, echoContribution("echo"))}},
			// 首条实例一致，第二条重复只报重复；投影一致因此没有别的 Issue。
			wantCodes: []string{IssueInstanceDuplicate},
		},
		{
			name:       "投影孤儿",
			state:      ControlState{Revision: 1},
			live:       fakeProjections{snapshots: []Projection{projectionOf(5, echoContribution("orphan"))}},
			wantCodes:  []string{IssueProjectionOrphan},
			wantStatus: map[string]string{"orphan": InstanceStatusProjected},
		},
		{
			name: "清单没有贡献项不要求投影",
			state: ControlState{Revision: 1, Instances: []InstanceRecord{{
				InstanceID: "plain", PluginID: "plain", Version: "1.0.0", Enabled: true,
			}}, Installed: []InstalledRecord{{
				PluginID: "plain", Version: "1.0.0", Manifest: Manifest{PluginID: "plain", Version: "1.0.0"},
			}}},
			live:      fakeProjections{},
			wantCodes: []string{},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			inventory := BuildInventory(test.state, test.live)
			if got := issueCodes(inventory); !reflect.DeepEqual(got, test.wantCodes) {
				t.Fatalf("Issue 码不符: got %v want %v (%+v)", got, test.wantCodes, inventory.Consistency.Issues)
			}
			if inventory.Consistency.OK != (len(test.wantCodes) == 0) {
				t.Fatalf("Consistency.OK 与 Issue 不一致: %+v", inventory.Consistency)
			}
			for instanceID, want := range test.wantStatus {
				if got := runtimeStatus(inventory, instanceID); got != want {
					t.Fatalf("实例 %s 状态: got %s want %s", instanceID, got, want)
				}
			}
			if test.check != nil {
				test.check(t, inventory)
			}
		})
	}
}

// TestBuildInventorySignatureDefault 保证未签名制品按 Node 契约回落到 unsigned。
func TestBuildInventorySignatureDefault(t *testing.T) {
	installed := echoInstalled()
	installed.Signature = nil
	inventory := BuildInventory(ControlState{Installed: []InstalledRecord{installed}}, fakeProjections{})
	var signature map[string]any
	if err := json.Unmarshal(inventory.Installed[0].Signature, &signature); err != nil {
		t.Fatalf("签名不是合法 JSON: %v", err)
	}
	if signature["status"] != "unsigned" {
		t.Fatalf("未签名制品应回落 unsigned: %+v", signature)
	}
}

// TestDecodeControlStateRejectsUnknownSchema 是失败关闭守卫：未来版本不能被当成当前结构。
func TestDecodeControlStateRejectsUnknownSchema(t *testing.T) {
	if _, err := DecodeControlState([]byte(`{"schemaVersion":2}`)); err == nil {
		t.Fatal("未知 schemaVersion 应被拒绝")
	}
	state, err := DecodeControlState([]byte(`{"revision":-3}`))
	if err != nil {
		t.Fatalf("缺省 schemaVersion 应接受: %v", err)
	}
	if state.Revision != 0 || state.Installed == nil || state.Instances == nil {
		t.Fatalf("负 revision 与空数组未归一: %+v", state)
	}
}
