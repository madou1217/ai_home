package modelmetadata

import (
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

func TestNewModelDescriptorCopiesValidatedInput(t *testing.T) {
	input := []string{"text", "image"}
	descriptor, err := NewModelDescriptor(ModelDescriptorInput{
		ProviderID: "kimi",
		ModelID:    "kimi-vision",
		Modalities: mustModalities(t, input, []string{"text"}),
	})
	if err != nil {
		t.Fatalf("NewModelDescriptor() error = %v", err)
	}
	input[1] = "video"
	got := descriptor.Modalities().Input()
	if len(got) != 2 || got[1] != "image" {
		t.Fatalf("descriptor modalities = %#v, want independent [text image]", got)
	}
	if descriptor.ProviderID() != "kimi" || descriptor.ModelID().String() != "kimi-vision" || !descriptor.IsValid() {
		t.Fatalf("descriptor identity/validity mismatch: provider=%q model=%q valid=%v", descriptor.ProviderID(), descriptor.ModelID(), descriptor.IsValid())
	}
}

func TestNewModelDescriptorRejectsInvalidInput(t *testing.T) {
	modalities := mustModalities(t, []string{"text"}, []string{"text"})
	tests := []ModelDescriptorInput{
		{ProviderID: "", ModelID: "kimi", Modalities: modalities},
		{ProviderID: "kimi", ModelID: "", Modalities: modalities},
		{ProviderID: "kimi", ModelID: "kimi", Modalities: Modalities{}},
	}
	for index, input := range tests {
		if _, err := NewModelDescriptor(input); err == nil {
			t.Errorf("case %d: NewModelDescriptor() error = nil, want rejection", index)
		}
	}
}

func TestModelDescriptorRegistrarContract(t *testing.T) {
	var _ ModelDescriptorRegistrar = descriptorRegistrarProbe{}
}

type descriptorRegistrarProbe struct{}

func (descriptorRegistrarProbe) ReplaceModelDescriptors(string, []ModelDescriptor) error {
	return nil
}

func mustModalities(t *testing.T, input, output []string) Modalities {
	t.Helper()
	modalities, err := NewModalities(input, output)
	if err != nil {
		t.Fatalf("NewModalities() error = %v", err)
	}
	return modalities
}

func TestModelDescriptorUsesCanonicalModelValidation(t *testing.T) {
	if _, err := runtimecore.NewModelID("kimi-vision"); err != nil {
		t.Fatalf("test model id unexpectedly invalid: %v", err)
	}
}
