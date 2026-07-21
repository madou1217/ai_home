import {
  nonNegativeInteger,
  protocolFailure,
  record,
  text,
} from './dto-guards';
import type {
  CapabilityDescriptor,
  CapabilitySnapshot,
  CapabilitySupport,
  ChatCapabilityName,
} from './capability-types';

const CAPABILITIES = new Set<ChatCapabilityName>([
  'session.resume', 'timeline.reasoning', 'timeline.tool', 'timeline.diff',
  'mode.plan', 'interaction.question', 'interaction.approval',
  'interaction.plan_confirmation', 'turn.interrupt', 'turn.steer.current',
  'turn.steer.tool_boundary', 'turn.queue', 'slash.execute', 'terminal.stream', 'run.adopt',
]);
const SUPPORT = new Set<CapabilitySupport>(['native', 'emulated', 'unsupported', 'unknown']);
const SNAPSHOT_FIELDS = new Set([
  'revision', 'capturedAt', 'capabilities', 'slashCommands', 'turnInterveneModes',
]);
const DESCRIPTOR_FIELDS = new Set(['support', 'reason', 'alternatives']);

export function parseCapabilitySnapshot(value: unknown): CapabilitySnapshot {
  const source = record(value, 'chat_runtime_capabilities_invalid');
  requireKnownFields(source, SNAPSHOT_FIELDS, 'chat_runtime_capabilities_shape_invalid');
  return {
    ...(source.revision === undefined ? {} : {
      revision: text(source.revision, 'chat_runtime_capabilities_revision_invalid'),
    }),
    ...(source.capturedAt === undefined ? {} : {
      capturedAt: nonNegativeInteger(
        source.capturedAt,
        'chat_runtime_capabilities_captured_at_invalid',
      ),
    }),
    ...(source.capabilities === undefined ? {} : {
      capabilities: parseCapabilities(source.capabilities),
    }),
    ...(source.slashCommands === undefined ? {} : {
      slashCommands: parseStringList(source.slashCommands, 'slash_commands'),
    }),
    ...(source.turnInterveneModes === undefined ? {} : {
      turnInterveneModes: parseStringList(source.turnInterveneModes, 'turn_intervene_modes'),
    }),
  };
}

function parseCapabilities(value: unknown) {
  const source = record(value, 'chat_runtime_capability_map_invalid');
  const result: Partial<Record<ChatCapabilityName, CapabilityDescriptor>> = {};
  Object.entries(source).forEach(([name, descriptor]) => {
    if (!CAPABILITIES.has(name as ChatCapabilityName)) {
      protocolFailure('chat_runtime_capability_name_invalid');
    }
    result[name as ChatCapabilityName] = parseDescriptor(descriptor);
  });
  return result;
}

function parseDescriptor(value: unknown): CapabilityDescriptor {
  const source = record(value, 'chat_runtime_capability_descriptor_invalid');
  requireKnownFields(source, DESCRIPTOR_FIELDS, 'chat_runtime_capability_descriptor_shape_invalid');
  const support = text(source.support, 'chat_runtime_capability_support_invalid') as CapabilitySupport;
  if (!SUPPORT.has(support)) protocolFailure('chat_runtime_capability_support_invalid');
  return {
    support,
    ...(source.reason === undefined ? {} : {
      reason: text(source.reason, 'chat_runtime_capability_reason_invalid'),
    }),
    ...(source.alternatives === undefined ? {} : {
      alternatives: parseAlternatives(source.alternatives),
    }),
  };
}

function parseAlternatives(value: unknown): readonly string[] {
  return parseStringList(value, 'alternatives');
}

function parseStringList(value: unknown, field: string): readonly string[] {
  const code = `chat_runtime_capability_${field}_invalid`;
  if (!Array.isArray(value)) protocolFailure(code);
  return value.map((entry) => text(entry, code));
}

function requireKnownFields(
  source: Record<string, unknown>, fields: ReadonlySet<string>, code: string,
): void {
  if (Object.keys(source).some((field) => !fields.has(field))) protocolFailure(code);
}
