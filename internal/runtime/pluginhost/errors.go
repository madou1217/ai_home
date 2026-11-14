package pluginhost

import (
	"errors"
	"strings"

	plugincontrol "github.com/madou1217/ai_home/application/plugincontrol"
	plugincontract "github.com/madou1217/ai_home/contracts/plugins"
	adapterplugins "github.com/madou1217/ai_home/internal/adapters/pluginruntime"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

// 插件宿主运行期与控制面编排错误码，与 Node pluginhost / control.js 逐字一致。
const (
	CodePublishBusy               = plugincontrol.CodePublishBusy
	CodeTicketUnknown             = plugincontrol.CodeTicketUnknown
	CodeTicketExpired             = plugincontrol.CodeTicketExpired
	CodeCandidateRejected         = plugincontrol.CodeCandidateRejected
	CodeConfigInvalid             = plugincontrol.CodeConfigInvalid
	CodeConfigUnsupported         = "plugin_config_unsupported"
	CodePermissionsUnacknowledged = plugincontrol.CodePermissionsUnacknowledged
	CodeRuntimeUnavailable        = plugincontrol.CodeRuntimeUnavailable
	CodeOperationInvalid          = plugincontrol.CodeOperationInvalid
	CodeInstanceUnknown           = plugincontrol.CodeInstanceUnknown
	CodeNotInstalled              = plugincontrol.CodeNotInstalled
	CodeVersionAmbiguous          = plugincontrol.CodeVersionAmbiguous
	CodeVersionConflict           = plugincontrol.CodeVersionConflict
	CodeRevisionConflict          = plugincontrol.CodeRevisionConflict
	CodeStateUnavailable          = plugincontrol.CodeStateUnavailable
	CodeStateInvalid              = plugincontrol.CodeStateInvalid

	CodePluginIDRequired       = "plugin_id_required"
	CodeInstanceIDInvalid      = "plugin_instance_id_invalid"
	CodeInstanceConflict       = "plugin_instance_conflict"
	CodeInstanceDuplicate      = "plugin_instance_duplicate"
	CodePluginIDDuplicate      = "plugin_id_duplicate"
	CodeContributionDuplicate  = "plugin_contribution_duplicate"
	CodeServiceReserved        = "plugin_service_reserved"
	CodeServiceConflict        = "plugin_service_conflict"
	CodeServiceMissing         = "plugin_service_missing"
	CodeServiceVersionMismatch = "plugin_service_version_mismatch"
	CodeDependencyCycle        = "plugin_dependency_cycle"
	CodeManifestInvalid        = "plugin_manifest_invalid"
	CodeSpecInvalid            = "plugin_spec_invalid"

	CodeGenerationInvalid = "plugin_generation_invalid"
	CodeGenerationUnknown = plugincontract.CodeGenerationUnknown
	CodeHostStartTimeout  = "plugin_host_start_timeout"
	CodeHostStartFailed   = "plugin_host_start_failed"
	CodeHostExited        = "plugin_host_exited"

	CodeDescriptorInvalid             = "provider_descriptor_invalid"
	CodeDescriptorNotSerializable     = "provider_descriptor_not_serializable"
	CodeDescriptorContributionInvalid = "provider_descriptor_contribution_invalid"
	CodeDescriptorDuplicate           = "provider_descriptor_duplicate"
	CodeDescriptorHandlerUnavailable  = "provider_descriptor_handler_unavailable"
	CodeDescriptorCollectFailed       = "provider_descriptor_collect_failed"

	CodeCatalogFailed   = "plugin_catalog_failed"
	CodeCatalogInvalid  = "plugin_catalog_invalid"
	CodeCatalogConflict = "plugin_catalog_conflict"
)

func errorCode(err error) string {
	if err == nil {
		return ""
	}
	if coded, ok := pluginerr.From(err); ok && strings.TrimSpace(coded.Code) != "" {
		return coded.Code
	}
	var rpcErr *adapterplugins.Error
	if errors.As(err, &rpcErr) && strings.TrimSpace(rpcErr.Code) != "" {
		return rpcErr.Code
	}
	return ""
}

func newCandidateRejectedError(message string, diagnostics []PrepareDiagnostic) *pluginerr.Error {
	err := pluginerr.New(CodeCandidateRejected, message)
	if len(diagnostics) > 0 {
		err.Diagnostics = make([]any, 0, len(diagnostics))
		for _, item := range diagnostics {
			err.Diagnostics = append(err.Diagnostics, item)
		}
	}
	return err
}
