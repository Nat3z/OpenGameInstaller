export type WindowsJobLaunchEvidence = {
  version: 1;
  rootPid: number;
  killOnClose: true;
};
export type WindowsJobResultEvidence = {
  version: 1;
  rootPid: number;
  survivingPids: number[];
  timedOut: boolean;
  killOnClose: true;
};
export function parseWindowsJobLaunchEvidence(
  contents: string
): WindowsJobLaunchEvidence;
export function parseWindowsJobResultEvidence(
  contents: string
): WindowsJobResultEvidence;
