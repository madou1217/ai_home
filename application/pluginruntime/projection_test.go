package pluginruntime

import (
	"reflect"
	"testing"
)

// TestRegistrySnapshotsAreSortedAndIsolated 保证一致性诊断拿到的是一份独立快照：
// 代次排序稳定，调用方修改返回值不会污染注册表。
func TestRegistrySnapshotsAreSortedAndIsolated(t *testing.T) {
	registry := NewRegistry()
	host := HostAccess{Address: "127.0.0.1:1", Token: "token"}
	accepted, err := registry.Replace(host, []Projection{
		projectionOf(5, echoContribution("echo")),
		projectionOf(2, Contribution{ID: "old.reply", Capability: "gateway.request", FailurePolicy: "deny", InstanceID: "old"}),
	}, nil)
	if err != nil {
		t.Fatalf("安装投影失败: %v", err)
	}
	if !reflect.DeepEqual(accepted, []int64{2, 5}) {
		t.Fatalf("接受代次不符: %v", accepted)
	}
	snapshots := registry.Snapshots()
	if len(snapshots) != 2 || snapshots[0].Generation != 2 || snapshots[1].Generation != 5 {
		t.Fatalf("快照未按代次升序: %+v", snapshots)
	}
	snapshots[0].Contributions[0].ID = "mutated"
	if projection, found := registry.Get(2); !found || projection.Contributions[0].ID != "old.reply" {
		t.Fatalf("修改快照污染了注册表: %+v", projection)
	}
	if _, err := registry.Replace(host, []Projection{projectionOf(9, echoContribution("echo"))}, nil); err != nil {
		t.Fatalf("替换投影失败: %v", err)
	}
	if got := registry.Snapshots(); len(got) != 1 || got[0].Generation != 9 {
		t.Fatalf("整体替换未生效: %+v", got)
	}
}
