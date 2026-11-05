package gemini

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestVertexIdentityMatchesNodeFormula(t *testing.T) {
	auth, err := NewVertexAuth(VertexInput{
		ProjectID:   "vertex-placeholder-project",
		Location:    "global",
		APIKey:      "aih_client_test",
		BaseURL:     "http://127.0.0.1:9527",
		Placeholder: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("aih_client_test"))
	want := "vertex_ai:gemini:vertex-placeholder-project:global:" + hex.EncodeToString(digest[:])[:16]
	if got := auth.IdentitySeed(); got != want {
		t.Fatalf("seed = %q, want %q", got, want)
	}
	if !auth.Placeholder() || auth.ProjectID() != "vertex-placeholder-project" || auth.Location() != "global" {
		t.Fatalf("auth = %#v", auth)
	}
}
