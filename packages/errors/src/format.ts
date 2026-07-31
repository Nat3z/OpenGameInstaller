export const formatError = (error: unknown): string => {
  if (typeof error === 'object' && error !== null && '_tag' in error) {
    const tagged = error as { _tag: string; message?: string };
    return tagged.message ?? tagged._tag;
  }
  if (error instanceof Error) return error.message;
  return String(error);
};

export const formatErrorResponse = (
  error: unknown
): { status: 'error'; error: string } => ({
  status: 'error',
  error: formatError(error),
});
