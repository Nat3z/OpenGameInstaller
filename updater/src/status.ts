export type UpdaterStatusSeverity = 'polite' | 'assertive';

export type UpdaterStatusPayload =
  | {
      readonly kind: 'status' | 'recovery';
      readonly severity: 'polite';
      readonly title: string;
      readonly detail?: string;
    }
  | {
      readonly kind: 'progress';
      readonly severity: 'polite';
      readonly title: string;
      readonly detail?: string;
      readonly progress: {
        readonly value: number;
        readonly max: number;
      };
    }
  | {
      readonly kind: 'failure';
      readonly severity: 'assertive';
      readonly title: string;
      readonly detail?: string;
    };

export function updaterStatus(
  title: string,
  detail?: string
): UpdaterStatusPayload {
  return { kind: 'status', severity: 'polite', title, detail };
}

export function updaterProgress(
  title: string,
  value: number,
  max: number,
  detail?: string
): UpdaterStatusPayload {
  return {
    kind: 'progress',
    severity: 'polite',
    title,
    detail,
    progress: { value, max },
  };
}

export function updaterFailure(
  title: string,
  detail?: string
): UpdaterStatusPayload {
  return { kind: 'failure', severity: 'assertive', title, detail };
}

export function updaterRecovery(
  title: string,
  detail?: string
): UpdaterStatusPayload {
  return { kind: 'recovery', severity: 'polite', title, detail };
}
