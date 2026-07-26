export type WindowsJobLaunchEvidence = {
  version: 1;
  rootPid: number;
  killOnClose: true;
};
export type LegacyWindowsJobResultEvidence = {
  version: 2;
  rootPid: number;
  activePidsBeforeClose: number[];
  survivingPids: number[];
  timedOut: boolean;
  killOnClose: true;
  verifiedAfterClose: false;
};
export type WindowsJobResultEvidence = {
  version: 3;
  rootPid: number;
  activePidsBeforeClose: number[];
  terminatedPids: number[];
  survivingPids: number[];
  timedOut: boolean;
  errors: string[];
  killOnClose: true;
  verifiedAfterClose: true;
};
export function parseWindowsJobLaunchEvidence(
  contents: string
): WindowsJobLaunchEvidence;
export function parseWindowsJobResultEvidence(
  contents: string
): LegacyWindowsJobResultEvidence | WindowsJobResultEvidence;
