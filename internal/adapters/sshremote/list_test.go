package sshremote

import (
	"context"
	"io"
	"strings"
	"sync"
	"testing"
)

func TestListDirectoryParsesEntries(t *testing.T) {
	t.Parallel()
	var mutex sync.Mutex
	var commands []string
	server := startTestServer(t, testServerOptions{
		Password: "secret",
		Exec: func(command string, stdout, _ io.Writer) uint32 {
			mutex.Lock()
			commands = append(commands, command)
			mutex.Unlock()
			_, _ = io.WriteString(stdout, strings.Join([]string{
				"directory\t4096\t1700000000\tsrc",
				"regular file\t128\t1700000001\ta b.txt",
				"symbolic link\t0\t0\tcurrent",
				"",
			}, "\n"))
			return 0
		},
	})
	config := testConfig(t, server, AuthPassword)
	config.Password = "secret"
	client := dialTest(t, config)

	list, err := client.ListDirectory(context.Background(), "/srv/app/")
	if err != nil {
		t.Fatalf("列目录失败: %v", err)
	}
	if list.Truncated {
		t.Fatalf("不该截断: %#v", list)
	}
	if len(list.Entries) != 3 {
		t.Fatalf("条目数 = %d, want 3: %#v", len(list.Entries), list.Entries)
	}
	src := list.Entries[0]
	if src.Name != "src" || src.Path != "/srv/app/src" || src.Type != "d" || src.Size != 4096 {
		t.Fatalf("src = %#v", src)
	}
	if src.Modified.Unix() != 1700000000 {
		t.Fatalf("src.Modified = %v", src.Modified)
	}
	file := list.Entries[1]
	if file.Name != "a b.txt" || file.Path != "/srv/app/a b.txt" || file.Type != "f" || file.Size != 128 {
		t.Fatalf("file = %#v", file)
	}
	link := list.Entries[2]
	if link.Type != "l" || link.Name != "current" {
		t.Fatalf("link = %#v", link)
	}

	mutex.Lock()
	defer mutex.Unlock()
	if len(commands) != 1 || !strings.Contains(commands[0], "d='/srv/app'") {
		t.Fatalf("远端命令 = %#v", commands)
	}
}

func TestListDirectoryClassifiesNotFound(t *testing.T) {
	t.Parallel()
	server := startTestServer(t, testServerOptions{
		Password: "secret",
		Exec: func(_ string, _, stderr io.Writer) uint32 {
			_, _ = io.WriteString(stderr, "NOENT")
			return 3
		},
	})
	config := testConfig(t, server, AuthPassword)
	config.Password = "secret"
	client := dialTest(t, config)
	_, err := client.ListDirectory(context.Background(), "/missing")
	if ErrorCode(err) != "not_found" {
		t.Fatalf("错误码 = %q, want not_found (%v)", ErrorCode(err), err)
	}
}

func TestListDirectoryRejectsRelativePath(t *testing.T) {
	t.Parallel()
	for _, input := range []string{"", "srv/app", "/srv/../etc", "/srv/app\n"} {
		if _, err := normalizeRemoteDirectory(input); ErrorCode(err) != CodeInvalidPath {
			t.Fatalf("normalizeRemoteDirectory(%q) = %v, want %s", input, err, CodeInvalidPath)
		}
	}
	got, err := normalizeRemoteDirectory("  /srv//app/  ")
	if err != nil || got != "/srv/app" {
		t.Fatalf("normalizeRemoteDirectory = %q, %v", got, err)
	}
}
