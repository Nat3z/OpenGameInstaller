/**
 * Windows game launch via ShellExecute (PowerShell Start-Process).
 *
 * child_process.spawn() uses CreateProcess and cannot trigger UAC for executables
 * that declare requireAdministrator in their manifest. Start-Process uses ShellExecute
 * and shows the elevation prompt when required.
 */
import { spawn, type ChildProcess } from 'child_process';

function quotePowerShellSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quotePowerShellEnvName(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid environment variable name: ${name}`);
  }
  return name;
}

export function buildWindowsLaunchScript(options: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): string {
  const { executable, args, cwd, env } = options;

  const envAssignments = Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(
      ([key, value]) =>
        `$env:${quotePowerShellEnvName(key)}=${quotePowerShellSingle(value)}`
    )
    .join('; ');

  const argumentList =
    args.length > 0
      ? `-ArgumentList ${args.map(quotePowerShellSingle).join(',')}`
      : '';

  const startProcess = [
    '$p = Start-Process',
    `-FilePath ${quotePowerShellSingle(executable)}`,
    argumentList,
    `-WorkingDirectory ${quotePowerShellSingle(cwd)}`,
    '-PassThru',
  ]
    .filter((part) => part.length > 0)
    .join(' ');

  return [
    envAssignments,
    startProcess,
    'if (-not $p) { exit 1 }',
    '$p.WaitForExit()',
    'exit $p.ExitCode',
  ]
    .filter((part) => part.length > 0)
    .join('; ');
}

export function spawnWindowsGameProcess(options: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ChildProcess {
  const script = buildWindowsLaunchScript(options);

  return spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      env: process.env,
      windowsHide: true,
      stdio: 'ignore',
    }
  );
}
