package sessionread

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestReadClaudeKnownPathsMergesConfigRootAndLegacy(t *testing.T) {
	home := t.TempDir()
	writeTestFile(t, filepath.Join(home, ".claude", ".claude.json"), `{"projects":{"/repo/nested":{},"/repo/shared":{}}}`)
	writeTestFile(t, filepath.Join(home, ".claude.json"), `{"projects":{"/repo/legacy":{},"/repo/shared":{}}}`)

	got := readClaudeKnownPaths(home)
	want := []string{"/repo/legacy", "/repo/nested", "/repo/shared"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("readClaudeKnownPaths = %#v, want %#v", got, want)
	}
}

func TestReadClaudeKnownPathsFallsBackToLegacy(t *testing.T) {
	home := t.TempDir()
	writeTestFile(t, filepath.Join(home, ".claude.json"), `{"projects":{"/repo/legacy":{}}}`)

	got := readClaudeKnownPaths(home)
	want := []string{"/repo/legacy"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("readClaudeKnownPaths = %#v, want %#v", got, want)
	}
}
