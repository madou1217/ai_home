package accountusage

import (
	"fmt"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestProviderQueuePopsInOrderAndCompacts 验证长队列出队保持顺序且不做逐项搬移。
func TestProviderQueuePopsInOrderAndCompacts(t *testing.T) {
	t.Parallel()

	const taskCount = 2_050
	queue := &providerQueue{
		tasks: make([]*scheduledRefresh, 0, taskCount),
	}
	for index := 1; index <= taskCount; index++ {
		accountRef, err := accountcore.ParseAccountRef(
			fmt.Sprintf("acct_%020x", index),
		)
		if err != nil {
			t.Fatalf("ParseAccountRef(%d) error = %v", index, err)
		}
		queue.tasks = append(queue.tasks, &scheduledRefresh{
			accountRef: accountRef,
		})
	}
	for index := 1; index <= taskCount; index++ {
		task, available := popProviderTask(queue)
		if !available ||
			task.accountRef.String() != fmt.Sprintf("acct_%020x", index) {
			t.Fatalf(
				"pop(%d) = (%s, %t)",
				index,
				task.accountRef,
				available,
			)
		}
	}
	if queue.head != 0 || len(queue.tasks) != 0 {
		t.Fatalf(
			"drained queue head=%d len=%d",
			queue.head,
			len(queue.tasks),
		)
	}
	if _, available := popProviderTask(queue); available {
		t.Fatal("空队列不应返回任务")
	}
}
