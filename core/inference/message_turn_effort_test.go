package inference

import "testing"

func TestTurnEffortOnlyRidesOnSystemMessages(t *testing.T) {
	text, err := NewTextContent("turn")
	if err != nil {
		t.Fatal(err)
	}
	system, _ := NewMessage(RoleSystem, text)
	user, _ := NewMessage(RoleUser, text)

	withEffort, err := system.WithTurnEffort(ReasoningEffortMedium)
	if err != nil || withEffort.TurnEffort() != ReasoningEffortMedium || !withEffort.IsValid() {
		t.Fatalf("system turn effort: %v %q", err, withEffort.TurnEffort())
	}
	if system.TurnEffort() != "" {
		t.Fatal("WithTurnEffort must not mutate the original message")
	}
	if withEffort.clone().TurnEffort() != ReasoningEffortMedium {
		t.Fatal("clone must keep the turn effort")
	}
	for _, effort := range []ReasoningEffort{"", ReasoningEffortNone, "turbo"} {
		if _, err := system.WithTurnEffort(effort); err == nil {
			t.Fatalf("effort %q must be rejected", effort)
		}
	}
	if _, err := user.WithTurnEffort(ReasoningEffortHigh); err == nil {
		t.Fatal("only system messages can carry a turn effort")
	}
}
