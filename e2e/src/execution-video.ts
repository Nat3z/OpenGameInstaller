import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

export type ExecutionVideoRecording = {
  path: string;
  process: ChildProcess;
  display?: string;
  displayProcess?: ChildProcess;
  stopped: boolean;
};

async function startLinuxDisplay() {
  for (let number = 90; number < 120; number++) {
    const display = `:${number}`;
    if (existsSync(`/tmp/.X11-unix/X${number}`)) continue;
    const child = spawn(
      'Xvfb',
      [display, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'],
      {
        stdio: 'ignore',
      }
    );
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5_000;
      const check = () => {
        if (existsSync(`/tmp/.X11-unix/X${number}`)) {
          resolve();
          return;
        }
        if (child.exitCode !== null || Date.now() >= deadline) {
          reject(new Error(`Could not start Xvfb display ${display}`));
          return;
        }
        setTimeout(check, 25);
      };
      child.once('error', reject);
      check();
    });
    return { display, child };
  }
  throw new Error('No free Xvfb display is available for execution video');
}

function ffmpegArguments(
  path: string,
  platform: NodeJS.Platform,
  display?: string
) {
  const input =
    platform === 'linux'
      ? [
          '-f',
          'x11grab',
          '-framerate',
          '15',
          '-video_size',
          '1280x720',
          '-i',
          display!,
        ]
      : platform === 'win32'
        ? ['-f', 'gdigrab', '-framerate', '15', '-i', 'desktop']
        : platform === 'darwin'
          ? [
              '-f',
              'avfoundation',
              '-framerate',
              '15',
              '-capture_cursor',
              '1',
              '-i',
              'Capture screen 0:none',
            ]
          : undefined;
  if (!input) {
    throw new Error(`Execution video capture is unsupported on ${platform}`);
  }
  return [
    '-y',
    ...input,
    '-an',
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-pix_fmt',
    'yuv420p',
    path,
  ];
}

export async function startExecutionVideo(options: {
  path: string;
  platform?: NodeJS.Platform;
  display?: string;
  ffmpegPath?: string;
}) {
  const platform = options.platform ?? process.platform;
  const ownedDisplay =
    platform === 'linux' && !options.display && !process.env.DISPLAY
      ? await startLinuxDisplay()
      : undefined;
  const display =
    options.display ?? process.env.DISPLAY ?? ownedDisplay?.display;
  const child = spawn(
    options.ffmpegPath ?? process.env.OGI_FFMPEG_PATH ?? 'ffmpeg',
    ffmpegArguments(options.path, platform, display),
    { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true }
  );
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (cause: Error) => {
      child.off('spawn', onSpawn);
      reject(cause);
    };
    const onSpawn = () => {
      child.off('error', onError);
      resolve();
    };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (child.exitCode !== null) {
    ownedDisplay?.child.kill('SIGTERM');
    throw new Error(
      `Execution video capture exited during startup (${child.exitCode}): ${stderr}`
    );
  }
  return {
    path: options.path,
    process: child,
    display,
    displayProcess: ownedDisplay?.child,
    stopped: false,
  } satisfies ExecutionVideoRecording;
}

export async function stopExecutionVideo(recording: ExecutionVideoRecording) {
  if (recording.stopped) return recording.path;
  recording.stopped = true;
  const child = recording.process;
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin?.write('q\n');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => child.kill('SIGTERM'), 5_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
  recording.displayProcess?.kill('SIGTERM');
  if (!existsSync(recording.path) || statSync(recording.path).size < 1_024) {
    throw new Error(`Execution video is missing or empty: ${recording.path}`);
  }
  return recording.path;
}
