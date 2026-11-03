import { protocolFailure } from './dto-guards';

export function assertExactFields(
  source: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  code: string,
): void {
  const allowed = new Set(fields);
  if (Object.keys(source).some((field) => !allowed.has(field))) protocolFailure(code);
}
