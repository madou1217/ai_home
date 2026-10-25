package modelsdev

import (
	"sync"
	"testing"

	"github.com/madou1217/ai_home/application/modelmetadata"
)

func TestRuntimeModalityOverrideTakesPrecedenceAndRevertsByProviderReplacement(t *testing.T) {
	index, err := New()
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	modelID := "kimi-k2"
	static, found := index.LookupModalities("kimi", modelID)
	if !found {
		t.Fatalf("static lookup for %s did not find a fixture", modelID)
	}
	override := mustDescriptor(t, "kimi", modelID, []string{"text", "image"}, []string{"text"})
	if err := index.ReplaceModelDescriptors("kimi", []modelmetadata.ModelDescriptor{override}); err != nil {
		t.Fatalf("ReplaceModelDescriptors() error = %v", err)
	}
	got, found := index.LookupModalities("kimi", modelID)
	if !found || got.Input()[1] != "image" {
		t.Fatalf("override lookup = %#v found=%v, want image input", got.Input(), found)
	}
	if len(got.Input()) != 2 || got.Output()[0] != "text" {
		t.Fatalf("override lookup = %#v/%#v, want exactly [text image]/[text]", got.Input(), got.Output())
	}
	if fallback, ok := index.LookupModalities("kimi", "definitely-uncovered-runtime-model"); ok {
		t.Fatalf("uncovered runtime model unexpectedly found static modalities: %#v", fallback.Input())
	}

	other := mustDescriptor(t, "kimi", "runtime-other-model", []string{"text"}, []string{"text"})
	if err := index.ReplaceModelDescriptors("kimi", []modelmetadata.ModelDescriptor{other}); err != nil {
		t.Fatalf("second provider replacement error = %v", err)
	}
	reverted, found := index.LookupModalities("kimi", modelID)
	if !found || len(reverted.Input()) != len(static.Input()) {
		t.Fatalf("replacement did not revert omitted model to static modalities: %#v found=%v", reverted.Input(), found)
	}
	if err := index.ReplaceModelDescriptors("kimi", nil); err != nil {
		t.Fatalf("empty provider replacement error = %v", err)
	}
	kept, found := index.LookupModalities("kimi", "runtime-other-model")
	if !found || len(kept.Input()) != 1 || kept.Input()[0] != "text" {
		t.Fatalf("empty replacement cleared last-known-good override: %#v found=%v", kept.Input(), found)
	}
}

func TestRuntimeModalityOverrideRejectsInvalidReplacementAndPreservesPrevious(t *testing.T) {
	index, err := New()
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	valid := mustDescriptor(t, "kimi", "runtime-only-model", []string{"text", "image"}, []string{"text"})
	if err := index.ReplaceModelDescriptors("kimi", []modelmetadata.ModelDescriptor{valid}); err != nil {
		t.Fatalf("valid replacement error = %v", err)
	}
	invalid := modelmetadata.ModelDescriptor{}
	if err := index.ReplaceModelDescriptors("kimi", []modelmetadata.ModelDescriptor{invalid}); err == nil {
		t.Fatalf("invalid replacement error = nil, want rejection")
	}
	got, found := index.LookupModalities("kimi", "runtime-only-model")
	if !found || len(got.Input()) != 2 || got.Input()[1] != "image" {
		t.Fatalf("previous override lost after invalid replacement: %#v found=%v", got.Input(), found)
	}
}

func TestRuntimeModalityOverrideConcurrentReadAndReplace(t *testing.T) {
	index, err := New()
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	descriptor := mustDescriptor(t, "kimi", "concurrent-model", []string{"text", "image"}, []string{"text"})
	var group sync.WaitGroup
	for range 4 {
		group.Add(1)
		go func() {
			defer group.Done()
			for range 100 {
				_, _ = index.LookupModalities("kimi", "concurrent-model")
			}
		}()
	}
	for range 20 {
		if err := index.ReplaceModelDescriptors("kimi", []modelmetadata.ModelDescriptor{descriptor}); err != nil {
			t.Fatalf("concurrent replacement error = %v", err)
		}
	}
	group.Wait()
}

func mustDescriptor(t *testing.T, providerID, modelID string, input, output []string) modelmetadata.ModelDescriptor {
	t.Helper()
	modalities, err := modelmetadata.NewModalities(input, output)
	if err != nil {
		t.Fatalf("NewModalities() error = %v", err)
	}
	descriptor, err := modelmetadata.NewModelDescriptor(modelmetadata.ModelDescriptorInput{
		ProviderID: providerID,
		ModelID:    modelID,
		Modalities: modalities,
	})
	if err != nil {
		t.Fatalf("NewModelDescriptor() error = %v", err)
	}
	return descriptor
}
