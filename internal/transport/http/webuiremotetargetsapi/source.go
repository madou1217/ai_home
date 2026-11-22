// Package webuiremotetargetsapi exposes the read-only remote execution target
// projection. It joins existing Server identity, SSH workspace, provider and
// account/model facts without copying credentials or inventing execution state.
package webuiremotetargetsapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/remoteexecution"
	"github.com/madou1217/ai_home/internal/runtime/providercli/sessionchat"
)

var (
	ErrInvalidSource = errors.New("remote execution target source is invalid")
)

// AccountModelReader is the existing account/model catalog read port.
type AccountModelReader interface {
	ListAllAccountModels(context.Context) (accountapp.AccountModelCatalog, error)
}

// AccountOverviewReader is the existing non-secret account projection read port.
type AccountOverviewReader interface {
	GetAccountOverview(context.Context, accountcore.AccountRef) (accountapp.AccountOverview, error)
}

// SSHConnectionReader reads the sanitized SSH connection projection.
// The remote-target projection depends on the read port, not on the SSH HTTP
// handler, so the composition root can reuse the existing source without
// coupling two inbound adapters together.
type SSHConnectionReader interface {
	ReadConnections(context.Context) (string, bool, error)
}

// SSHWorkspaceReader reads the sanitized SSH workspace projection.
type SSHWorkspaceReader interface {
	ReadWorkspaces(context.Context) (string, bool, error)
}

// FactsSource composes already-owned read models into one consistent target
// snapshot. It does not probe SSH or start an Agent; those belong to preflight
// and supervisor layers.
type FactsSource struct {
	ServerID       func(context.Context) (string, error)
	Connections    SSHConnectionReader
	Workspaces     SSHWorkspaceReader
	Catalog        *providers.Catalog
	AccountModels  AccountModelReader
	AccountDetails AccountOverviewReader
	// ConnectorWorkspaces is optional. It projects locally enrolled workspaces
	// with their current online/offline state; it never opens a connector RPC.
	ConnectorWorkspaces func(context.Context) ([]remoteexecution.WorkspaceFact, error)
}

func (source FactsSource) Read(ctx context.Context) (remoteexecution.Facts, error) {
	if ctx == nil || source.ServerID == nil || source.Connections == nil || source.Workspaces == nil ||
		source.Catalog == nil || source.AccountModels == nil || source.AccountDetails == nil {
		return remoteexecution.Facts{}, ErrInvalidSource
	}
	serverID, err := source.ServerID(ctx)
	if err != nil || strings.TrimSpace(serverID) == "" {
		return remoteexecution.Facts{}, fmt.Errorf("read server identity: %w", err)
	}
	connectionsRaw, connectionsFound, err := source.Connections.ReadConnections(ctx)
	if err != nil {
		return remoteexecution.Facts{}, fmt.Errorf("read ssh connections: %w", err)
	}
	workspacesRaw, workspacesFound, err := source.Workspaces.ReadWorkspaces(ctx)
	if err != nil {
		return remoteexecution.Facts{}, fmt.Errorf("read ssh workspaces: %w", err)
	}
	workspaces, err := decodeWorkspaces(workspacesRaw, workspacesFound, decodeConnections(connectionsRaw, connectionsFound))
	if err != nil {
		return remoteexecution.Facts{}, err
	}
	if source.ConnectorWorkspaces != nil {
		connectorWorkspaces, connectorErr := source.ConnectorWorkspaces(ctx)
		if connectorErr != nil {
			return remoteexecution.Facts{}, fmt.Errorf("read workspace connectors: %w", connectorErr)
		}
		workspaces = append(workspaces, connectorWorkspaces...)
	}
	models, err := source.AccountModels.ListAllAccountModels(ctx)
	if err != nil {
		return remoteexecution.Facts{}, fmt.Errorf("read account models: %w", err)
	}
	accountsByRef := make(map[string]accountapp.AccountOverview, len(models.Sets))
	for _, set := range models.Sets {
		overview, overviewErr := source.AccountDetails.GetAccountOverview(ctx, set.AccountRef)
		if overviewErr != nil {
			continue
		}
		accountsByRef[overview.Account().Ref().String()] = overview
	}

	facts := remoteexecution.Facts{
		ServerID:   strings.TrimSpace(serverID),
		Workspaces: workspaces,
		Runners:    runnerFacts(source.Catalog),
		Accounts:   make([]remoteexecution.AccountFact, 0, len(models.Sets)),
		Models:     make([]remoteexecution.ModelFact, 0),
	}
	for _, set := range models.Sets {
		accountRef := set.AccountRef.String()
		overview, found := accountsByRef[accountRef]
		if !found {
			// A model row without its base account cannot form an executable target.
			// Keep it out rather than fabricating enabled/credential state.
			continue
		}
		account := overview.Account()
		facts.Accounts = append(facts.Accounts, remoteexecution.AccountFact{
			AccountRef:        accountRef,
			Provider:          set.ProviderID,
			Enabled:           account.Enabled(),
			CredentialKnown:   overview.HasCredential(),
			ModelCount:        len(set.Models),
			EffectiveModels:   effectiveModelCount(set.Models),
			ModelCatalogKnown: set.LastSource != "" || len(set.Models) > 0,
		})
		for _, model := range set.Models {
			catalogID := model.ModelID().String()
			cliName := cliModelName(set.ProviderID, catalogID)
			facts.Models = append(facts.Models, remoteexecution.ModelFact{
				AccountRef:       accountRef,
				Provider:         set.ProviderID,
				CatalogModelID:   catalogID,
				CLIModelName:     cliName,
				Effective:        model.Effective(),
				CatalogAvailable: model.UpstreamAvailable(),
				// A catalog row and a static provider contract do not prove that
				// the remote CLI binary is installed, accepts this model, or can
				// attach the workspace. Keep launch fail-closed until the future
				// supervisor performs a real capability probe.
				NativeLaunchAvailable: false,
			})
		}
	}
	return facts, nil
}

func runnerFacts(catalog *providers.Catalog) []remoteexecution.RunnerFact {
	result := make([]remoteexecution.RunnerFact, 0)
	for _, definition := range catalog.List() {
		if definition.CLI == nil || definition.CLI.Headless == nil {
			continue
		}
		capabilities := []string{"headless"}
		if definition.NativeBoundary != nil && len(definition.NativeBoundary.Sessions.Flags) > 0 {
			capabilities = append(capabilities, "session")
		}
		supportsRemoteTools := definition.ID == "codex" || definition.ID == "claude"
		reason := "remote tool channel is available through the Workspace Connector"
		if supportsRemoteTools {
			capabilities = append(capabilities, "remote-tools")
		} else {
			reason = "agent has no structured tool channel; remote tools stay unsupported"
		}
		result = append(result, remoteexecution.RunnerFact{
			ID:                  definition.ID,
			Provider:            definition.ID,
			Kind:                "native-cli",
			Status:              "declared",
			SupportsHeadless:    true,
			SupportsRemoteTools: supportsRemoteTools,
			SupportsApproval:    false,
			Capabilities:        capabilities,
			Reason:              reason,
		})
	}
	return result
}

func cliModelName(provider, model string) string {
	if strings.EqualFold(provider, "agy") {
		return sessionchat.ResolveAgyCliModelName(model)
	}
	return strings.TrimSpace(model)
}

func effectiveModelCount(models []accountapp.AccountModel) int {
	count := 0
	for _, model := range models {
		if model.Effective() {
			count++
		}
	}
	return count
}

type connectionFact struct {
	ID    string
	Label string
	Host  string
	User  string
}

func decodeConnections(raw string, found bool) map[string]connectionFact {
	result := map[string]connectionFact{}
	if !found || strings.TrimSpace(raw) == "" {
		return result
	}
	var values []map[string]any
	if json.Unmarshal([]byte(raw), &values) != nil {
		return result
	}
	for _, value := range values {
		id := stringValue(value["id"])
		if id == "" {
			continue
		}
		result[id] = connectionFact{
			ID: id, Label: stringValue(value["label"]), Host: stringValue(value["host"]), User: stringValue(value["user"]),
		}
	}
	return result
}

func decodeWorkspaces(raw string, found bool, connections map[string]connectionFact) ([]remoteexecution.WorkspaceFact, error) {
	result := make([]remoteexecution.WorkspaceFact, 0)
	if !found || strings.TrimSpace(raw) == "" {
		return result, nil
	}
	var values []map[string]any
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return nil, fmt.Errorf("decode ssh workspaces: %w", err)
	}
	for _, value := range values {
		id := stringValue(value["id"])
		connectionID := stringValue(value["connectionId"])
		remoteRoot := stringValue(value["remoteRoot"])
		label := stringValue(value["label"])
		if id == "" || connectionID == "" || remoteRoot == "" || label == "" {
			continue
		}
		connection := connections[connectionID]
		host := connection.Host
		if connection.User != "" && host != "" {
			host = connection.User + "@" + host
		}
		result = append(result, remoteexecution.WorkspaceFact{
			ID: id, Transport: remoteexecution.TransportSSH,
			ConnectionID: connectionID, ConnectionLabel: connection.Label,
			Host: host, Label: label, RemoteRoot: remoteRoot,
		})
	}
	return result, nil
}

func stringValue(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}
