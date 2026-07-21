export type CommandOperationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

interface CommandOperation {
  readonly execute: () => Promise<unknown>;
  readonly onSuccess?: () => void;
}

export async function runCommandOperation(
  operation: CommandOperation,
): Promise<CommandOperationResult> {
  try {
    await operation.execute();
  } catch (error) {
    return { ok: false, error };
  }
  operation.onSuccess?.();
  return { ok: true };
}
