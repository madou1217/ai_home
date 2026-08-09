package modelmetadata_test

import (
	"errors"
	"testing"

	"github.com/madou1217/ai_home/application/modelmetadata"
)

// TestModalitiesOwnsValidatedCopies 验证模态值对象拒绝脏数据且不共享可变切片。
func TestModalitiesOwnsValidatedCopies(t *testing.T) {
	t.Parallel()

	input := []string{"text", "image", "pdf"}
	output := []string{"text"}
	modalities, err := modelmetadata.NewModalities(input, output)
	if err != nil {
		t.Fatalf("modelmetadata.NewModalities() error = %v", err)
	}
	input[0] = "mutated"
	output[0] = "mutated"
	firstInput := modalities.Input()
	firstOutput := modalities.Output()
	firstInput[0] = "mutated-again"
	firstOutput[0] = "mutated-again"
	if got := modalities.Input(); len(got) != 3 || got[0] != "text" {
		t.Fatalf("Input() = %#v", got)
	}
	if got := modalities.Output(); len(got) != 1 || got[0] != "text" {
		t.Fatalf("Output() = %#v", got)
	}
}

// TestModalitiesRejectsInvalidValues 验证空列表、空项和重复项失败关闭。
func TestModalitiesRejectsInvalidValues(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		input  []string
		output []string
	}{
		{name: "empty input", output: []string{"text"}},
		{name: "empty output", input: []string{"text"}},
		{name: "blank item", input: []string{"text", " "}, output: []string{"text"}},
		{name: "duplicate item", input: []string{"text", "text"}, output: []string{"text"}},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, err := modelmetadata.NewModalities(test.input, test.output)
			if !errors.Is(err, modelmetadata.ErrInvalidModalities) {
				t.Fatalf("NewModalities() error = %v", err)
			}
		})
	}
}

// TestTextOnlyReturnsCanonicalFallback 验证未知模型使用明确的保守文本模态。
func TestTextOnlyReturnsCanonicalFallback(t *testing.T) {
	t.Parallel()

	modalities := modelmetadata.TextOnly()
	if input, output := modalities.Input(), modalities.Output(); len(input) != 1 || input[0] != "text" ||
		len(output) != 1 || output[0] != "text" {
		t.Fatalf("TextOnly() input=%#v output=%#v", input, output)
	}
}
