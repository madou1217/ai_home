package main

import "testing"

func TestDisabledMCPNames(t *testing.T) {
	disabled, err := disabledMCPNames([]string{"a", "b", "c"}, []string{"b"})
	if err != nil || len(disabled) != 2 || disabled[0] != "a" || disabled[1] != "c" {
		t.Fatalf("disabled=%v err=%v", disabled, err)
	}
	if _, err := disabledMCPNames([]string{"a"}, []string{"missing"}); err == nil {
		t.Fatal("expected unknown mcp error")
	}
}
