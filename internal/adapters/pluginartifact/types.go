package pluginartifact

import "github.com/madou1217/ai_home/application/plugincontrol"

// 制品接受的入参/出参定义在应用层：适配器实现应用层端口，而不是反向定义领域类型。
type (
	AcceptOptions = plugincontrol.AcceptOptions
	Accepted      = plugincontrol.AcceptedArtifact
	Signature     = plugincontrol.Signature
)
