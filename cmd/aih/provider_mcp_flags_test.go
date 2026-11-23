package main

import "testing"

func TestStripNoMCPFlag(t *testing.T) {
	kept, disabled := stripNoMCPFlag([]string{"--no-mcp", "-m", "gpt-5"})
	if !disabled || len(kept) != 2 || kept[0] != "-m" {
		t.Fatalf("kept=%v disabled=%v", kept, disabled)
	}
	kept, disabled = stripNoMCPFlag([]string{"--", "--no-mcp"})
	if disabled || len(kept) != 2 || kept[1] != "--no-mcp" {
		t.Fatalf("post-separator flag must pass through: %v %v", kept, disabled)
	}
}
