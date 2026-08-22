export function isNixOSCommandResult(
  error: Error | null,
  stdout: string
): boolean {
  return error === null && stdout.trim().length > 0;
}
