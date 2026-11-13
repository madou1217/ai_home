package geo

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestJobManagerInstallUninstallAndDedupe(t *testing.T) {
	t.Parallel()
	validGz := gzipBytes(t, sampleMMDBPayload())
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		_, _ = w.Write(validGz)
	}))
	defer server.Close()

	aiHome := t.TempDir()
	manager := NewJobManager(JobManagerOptions{
		AIHomeDir:   aiHome,
		URLTemplate: server.URL + "/dbip-city-lite-%s.mmdb.gz",
		HTTPClient:  server.Client(),
	})
	events, cancelSub := manager.Subscribe()
	defer cancelSub()

	unknown := manager.Start(JobStartRequest{ResourceID: "unknown", Action: "install"})
	if unknown.OK || unknown.Error != "geo_resource_not_found" {
		t.Fatalf("未知资源 = %+v", unknown)
	}
	badAction := manager.Start(JobStartRequest{ResourceID: ResourceDBIPCityID, Action: "repair"})
	if badAction.OK || badAction.Error != "geo_action_unsupported" {
		t.Fatalf("非法动作 = %+v", badAction)
	}

	first := manager.Start(JobStartRequest{ResourceID: ResourceDBIPCityID, Action: "install"})
	if !first.OK || !first.Accepted || first.AlreadyRunning || first.Job == nil {
		t.Fatalf("首次启动失败 = %+v", first)
	}
	dup := manager.Start(JobStartRequest{ResourceID: ResourceDBIPCityID, Action: "install"})
	if !dup.OK || !dup.AlreadyRunning || dup.Job == nil || dup.Job.ID != first.Job.ID {
		t.Fatalf("重复启动未去重 = %+v", dup)
	}
	if active := manager.ListActive(); len(active) != 1 || active[0].ID != first.Job.ID {
		t.Fatalf("ListActive() = %+v", active)
	}

	close(release)
	ctx, cancelWait := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelWait()
	var terminal JobView
	for {
		select {
		case ev := <-events:
			if ev.Job.ID == first.Job.ID && isTerminalJobStatus(ev.Job.Status) {
				terminal = ev.Job
				goto DONE
			}
		case <-ctx.Done():
			t.Fatal("等待作业完成超时")
		}
	}
DONE:
	if terminal.Status != "succeeded" || terminal.Result == nil || !terminal.Result.Installed {
		t.Fatalf("终态不符合预期 = %+v", terminal)
	}

	uninst := manager.Start(JobStartRequest{ResourceID: ResourceDBIPCityID, Action: "uninstall"})
	if !uninst.OK || uninst.Job == nil {
		t.Fatalf("卸载启动失败 = %+v", uninst)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		got, ok := manager.Get(uninst.Job.ID)
		if ok && got.Status == "succeeded" {
			if _, statErr := os.Stat(ManagedDBIPPath(aiHome)); !os.IsNotExist(statErr) {
				t.Fatalf("卸载后文件仍存在")
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("卸载作业未在超时前完成")
}

func TestJobManagerCancelRunningDownload(t *testing.T) {
	t.Parallel()
	started := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case started <- struct{}{}:
		default:
		}
		<-r.Context().Done()
	}))
	defer server.Close()

	manager := NewJobManager(JobManagerOptions{
		AIHomeDir:   t.TempDir(),
		URLTemplate: server.URL + "/dbip-city-lite-%s.mmdb.gz",
		HTTPClient:  server.Client(),
	})
	res := manager.Start(JobStartRequest{ResourceID: ResourceDBIPCityID, Action: "install"})
	if !res.OK || res.Job == nil {
		t.Fatalf("启动失败 = %+v", res)
	}
	<-started
	cancelled := manager.Cancel(res.Job.ID)
	if !cancelled.OK || cancelled.Job == nil || cancelled.Job.Status != "cancelled" {
		t.Fatalf("Cancel() = %+v", cancelled)
	}
	again := manager.Cancel(res.Job.ID)
	if again.OK || again.Error != "job_not_cancellable" {
		t.Fatalf("重复 Cancel() = %+v", again)
	}
}
