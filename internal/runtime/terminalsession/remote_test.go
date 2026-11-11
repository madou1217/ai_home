package terminalsession

import (
	"context"
	"io"
	"sync"
	"testing"

	"github.com/madou1217/ai_home/internal/runtime/pty"
)

type fakeRemoteSession struct {
	mutex   sync.Mutex
	written []byte
	resized pty.Size
	closed  chan struct{}
	once    sync.Once
}

func newFakeRemoteSession() *fakeRemoteSession {
	return &fakeRemoteSession{closed: make(chan struct{})}
}

func (session *fakeRemoteSession) Read(buffer []byte) (int, error) {
	<-session.closed
	return 0, io.EOF
}

func (session *fakeRemoteSession) Write(buffer []byte) (int, error) {
	session.mutex.Lock()
	session.written = append(session.written, buffer...)
	session.mutex.Unlock()
	return len(buffer), nil
}

func (session *fakeRemoteSession) Close() error {
	session.once.Do(func() { close(session.closed) })
	return nil
}

func (session *fakeRemoteSession) Resize(size pty.Size) error {
	session.mutex.Lock()
	session.resized = size
	session.mutex.Unlock()
	return nil
}

func (session *fakeRemoteSession) Wait() error {
	<-session.closed
	return nil
}

func TestCreateUsesRemoteStarterAndSkipsLocalPath(t *testing.T) {
	fake := newFakeRemoteSession()
	var started any
	service := NewService(nil, Options{
		RemoteStarter: func(_ context.Context, remote any, size pty.Size) (pty.Session, error) {
			started = remote
			if size.Cols != 100 || size.Rows != 30 {
				t.Fatalf("size = %+v", size)
			}
			return fake, nil
		},
	})
	t.Cleanup(func() { _ = service.Close() })
	snapshot, err := service.Create(context.Background(), Spec{
		Key: "ssh:ws", Remote: "ssh-config", Size: pty.Size{Cols: 100, Rows: 30},
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if started != "ssh-config" {
		t.Fatalf("remote starter got %#v", started)
	}
	if snapshot.Path != "ssh" || snapshot.Status != StatusRunning {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	if err := service.Write(snapshot.ID, []byte("ls\r")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if _, err := service.Resize(snapshot.ID, pty.Size{Cols: 120, Rows: 40}); err != nil {
		t.Fatalf("Resize: %v", err)
	}
	fake.mutex.Lock()
	written := string(fake.written)
	resized := fake.resized
	fake.mutex.Unlock()
	if written != "ls\r" || resized != (pty.Size{Cols: 120, Rows: 40}) {
		t.Fatalf("written=%q resized=%+v", written, resized)
	}
}

func TestCreateRejectsRemoteWithoutStarter(t *testing.T) {
	service := NewService(nil, Options{})
	if _, err := service.Create(context.Background(), Spec{Key: "ssh:ws", Remote: "cfg"}); err != ErrInvalidSpec {
		t.Fatalf("err = %v", err)
	}
}
