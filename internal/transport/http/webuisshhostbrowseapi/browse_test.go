package webuisshhostbrowseapi

import (
	"strings"
	"testing"
)

func TestNormalizeRemotePath(t *testing.T) {
	valid := map[string]string{
		"/srv":         "/srv",
		"  /srv/app  ": "/srv/app",
		"/srv//app/":   "/srv/app",
		"/":            "/",
		"/srv/./app":   "/srv/app",
	}
	for input, want := range valid {
		got, err := normalizeRemotePath(input)
		if err != nil {
			t.Fatalf("normalizeRemotePath(%q) error = %v", input, err)
		}
		if got != want {
			t.Fatalf("normalizeRemotePath(%q) = %q, want %q", input, got, want)
		}
	}

	invalid := []string{
		"",
		"   ",
		"srv/app",
		"~/app",
		"/srv/../etc",
		"/srv/..",
		"/srv/app\n",
		"/srv/app\r",
		"/srv/app\x00",
		"/" + strings.Repeat("a", maxRemotePathBytes),
	}
	for _, input := range invalid {
		if _, err := normalizeRemotePath(input); err == nil {
			t.Fatalf("normalizeRemotePath(%q) 应当失败", input)
		}
	}
}

func TestParentRemotePath(t *testing.T) {
	cases := map[string]string{
		"/":         "/",
		"":          "/",
		"/srv":      "/",
		"/srv/app":  "/srv",
		"/srv/app/": "/srv",
	}
	for input, want := range cases {
		if got := parentRemotePath(input); got != want {
			t.Fatalf("parentRemotePath(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestListArgvKeepsPathAsSeparateArgument(t *testing.T) {
	cases := map[string][]string{
		"/srv":     {"ls", "-lA", "--", "/srv/"},
		"/":        {"ls", "-lA", "--", "/"},
		"/srv/app": {"ls", "-lA", "--", "/srv/app/"},
	}
	for input, want := range cases {
		got := listArgv(input)
		if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
			t.Fatalf("listArgv(%q) = %#v, want %#v", input, got, want)
		}
	}
}

func TestParseListing(t *testing.T) {
	stdout := strings.Join([]string{
		"total 8",
		"drwxr-xr-x  2 deploy deploy 4096 Nov 10 12:34 app",
		"-rw-r--r--  1 deploy deploy  128 Nov 10 11:00 my file.txt",
		"lrwxrwxrwx  1 deploy deploy    3 Nov 10 12:00 current -> app",
		"crw-rw-rw-  1 root   root   1, 3 Nov 10 12:34 null",
		"-rw-r--r--. 1 deploy deploy   10 Nov 10 12:34 with_acl",
		"garbage line",
		"",
	}, "\n")
	entries := parseListing(stdout, "/srv")

	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name)
	}
	want := "app,current,my file.txt,null,with_acl"
	if strings.Join(names, ",") != want {
		t.Fatalf("names = %v, want %s", names, want)
	}

	app := entries[0]
	if !app.IsDirectory || app.Type != "d" || app.Path != "/srv/app" || app.Size != 4096 {
		t.Fatalf("app = %#v", app)
	}
	file := entries[2]
	if file.IsDirectory || file.Type != "-" || file.Size != 128 || file.Path != "/srv/my file.txt" {
		t.Fatalf("file = %#v", file)
	}
	link := entries[1]
	if link.Type != "l" || link.IsDirectory || link.Name != "current" {
		t.Fatalf("link = %#v", link)
	}
	device := entries[3]
	if device.Name != "null" || device.Type != "c" || device.Size != 0 {
		t.Fatalf("device = %#v", device)
	}
	acl := entries[4]
	if acl.Permissions != "rw-r--r--" || acl.Modified != "Nov 10 12:34" {
		t.Fatalf("acl = %#v", acl)
	}
}

func TestParseListingEmpty(t *testing.T) {
	entries := parseListing("", "/srv")
	if entries == nil || len(entries) != 0 {
		t.Fatalf("entries = %#v", entries)
	}
}

func TestTruncateAtLine(t *testing.T) {
	output := []byte("aaa\nbbb\nccc\n")
	if got := string(truncateAtLine(output, len(output))); got != "aaa\nbbb\nccc\n" {
		t.Fatalf("未超限被改动: %q", got)
	}
	if got := string(truncateAtLine(output, 6)); got != "aaa\n" {
		t.Fatalf("截断 = %q", got)
	}
	if got := truncateAtLine(output, 3); got != nil {
		t.Fatalf("没有完整行时 = %q", got)
	}
}
