package aihserver

import (
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountdeletionruntime"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
)

// newAccountDeletionRuntime is the single host composition for browser aliases
// and canonical management deletion. The use case still owns durable deletion.
func newAccountDeletionRuntime(
	home string,
	catalog *providers.Catalog,
	nodeURL string,
	managementKey func() string,
	occupancy accountapp.DeletionOccupancy,
	preparation accountapp.DeletionPreparation,
	chat func() *chatruntime.Service,
) (*accountdeletionruntime.Guard, error) {
	guard, err := accountdeletionruntime.New(occupancy, preparation,
		accountdeletionruntime.NodeOwner{AIHomeDir: home, BaseURL: nodeURL, ManagementKey: managementKey},
		accountdeletionruntime.ChatOwner{Service: chat},
		accountdeletionruntime.NativeTerminalOwner{AIHomeDir: home},
		accountdeletionruntime.HostOwner{AIHomeDir: home, Catalog: catalog},
	)
	if err == nil {
		guard.AIHomeDir = home
	}
	return guard, err
}
