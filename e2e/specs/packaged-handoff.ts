import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { $, browser } from '@wdio/globals';
import {
  connect,
  type Page,
  type Browser as PuppeteerBrowser,
} from 'puppeteer-core';
import {
  completeProductJourneyAutomation,
  disconnectProductJourneyBrowser,
  FIXTURE_GAME_CONTENT,
  FIXTURE_TORRENT_PAYLOAD_MANIFEST,
  readPackagedHandoffRunDescriptor,
  verifyExactFixtureTree,
  verifyExactTorrentLibraryState,
} from '../src/packaged-handoff';
import { terminatePidTree } from '../src/process-tree';
import {
  makeRunEventWriter,
  readRecoveryHandoffEvents,
  replayRunEventLog,
} from '../src/run-events';

const descriptorPath = process.env.OGI_RUN_DESCRIPTOR;
if (!descriptorPath) throw new Error('OGI_RUN_DESCRIPTOR is required');
const descriptor = readPackagedHandoffRunDescriptor(descriptorPath);
const attempt = Number(process.env.OGI_SCENARIO_ATTEMPT ?? '1');
if (!Number.isInteger(attempt) || attempt < 1 || attempt > 2) {
  throw new Error('OGI_SCENARIO_ATTEMPT must be 1 or 2');
}
const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

function expectedFixtureLauncherBytes(installDirectory: string) {
  const launcherArguments = [
    `--remote-debugging-port=${descriptor.gameAutomationPort}`,
    `--marker=${join(descriptor.fixtureStateDirectory, 'fixture-game-launch.json')}`,
  ];
  const mainPath = join(installDirectory, 'fixture-game.cjs');
  return Buffer.from(
    process.platform === 'win32'
      ? `@echo off\r\n"${electronPath}" "${mainPath}" ${launcherArguments
          .map((argument) => `"${argument}"`)
          .join(' ')}\r\n`
      : `#!/bin/sh\nexec "${electronPath}" --no-sandbox "${mainPath}" ${launcherArguments
          .map((argument) => `"${argument}"`)
          .join(' ')}\n`
  );
}
const writeEvent = makeRunEventWriter(
  descriptor.eventLogPath,
  descriptor.runId,
  replayRunEventLog(descriptor.eventLogPath).lastSequence
);
const writtenRecoveryPhases = new Set<string>();

function writeObservedRecoveryEvents() {
  if (!existsSync(descriptor.handoffLogPath)) return;
  for (const recovery of readRecoveryHandoffEvents(descriptor.handoffLogPath)) {
    if (writtenRecoveryPhases.has(recovery.input.payload.phase)) continue;
    writeEvent(recovery.input, recovery.timestamp);
    writtenRecoveryPhases.add(recovery.input.payload.phase);
  }
}

async function clickButtonText(page: Page, text: string) {
  await page.waitForFunction(
    (label) =>
      [...document.querySelectorAll('button')].some(
        (button) => button.textContent?.trim() === label
      ),
    { timeout: 30_000 },
    text
  );
  await page.evaluate((label) => {
    const button = [...document.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Visible button "${label}" is unavailable`);
    }
    button.click();
  }, text);
}

async function waitForText(page: Page, text: string) {
  await page.waitForFunction(
    (expected) => document.body.innerText.includes(expected),
    { timeout: 30_000 },
    text
  );
}

function findFixtureFile(directory: string, name: string): string | undefined {
  if (!existsSync(directory)) return undefined;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findFixtureFile(entryPath, name);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === name) {
      return entryPath;
    }
  }
  return undefined;
}

async function assertAccessibleSurface(
  page: Page,
  selector: string,
  label: string
) {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async (rootSelector) => {
    const root = document.querySelector(rootSelector);
    if (!root) throw new Error(`Accessibility root not found: ${rootSelector}`);
    const axe = (
      window as typeof window & {
        axe: {
          run: (target: Element) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              help: string;
              nodes: Array<{ target: unknown }>;
            }>;
          }>;
        };
      }
    ).axe;
    return (await axe.run(root)).violations;
  }, selector);
  if (violations.length > 0) {
    throw new Error(
      `${label} has accessibility violations: ${violations
        .map(
          (violation) =>
            `${violation.impact ?? 'unknown'} ${violation.id}: ${violation.help} (${violation.nodes
              .map((node) => JSON.stringify(node.target))
              .join(', ')})`
        )
        .join('; ')}`
    );
  }
}

async function connectToApplication() {
  let connectedBrowser: PuppeteerBrowser | undefined;
  let applicationPage: Page | undefined;
  await browser.waitUntil(
    async () => {
      try {
        connectedBrowser = await connect({
          browserURL: `http://127.0.0.1:${descriptor.automationPort}`,
        });
        for (const candidate of await connectedBrowser.pages()) {
          if ((await candidate.title()) === 'OpenGameInstaller') {
            applicationPage = candidate;
            break;
          }
        }
        if (applicationPage) return true;
        await connectedBrowser.disconnect();
        connectedBrowser = undefined;
        return false;
      } catch {
        await connectedBrowser?.disconnect();
        connectedBrowser = undefined;
        return false;
      }
    },
    {
      timeout: 30_000,
      timeoutMsg: 'Automation did not connect to the packaged application',
    }
  );
  if (!connectedBrowser || !applicationPage) {
    throw new Error('Packaged application page is unavailable');
  }
  return { applicationBrowser: connectedBrowser, applicationPage };
}

async function connectToFixtureGame() {
  let connectedBrowser: PuppeteerBrowser | undefined;
  let fixtureGamePage: Page | undefined;
  await browser.waitUntil(
    async () => {
      try {
        connectedBrowser = await connect({
          browserURL: `http://127.0.0.1:${descriptor.gameAutomationPort}`,
        });
        for (const candidate of await connectedBrowser.pages()) {
          if ((await candidate.title()) === 'OpenGameInstaller Fixture Game') {
            fixtureGamePage = candidate;
            break;
          }
        }
        if (fixtureGamePage) return true;
        await connectedBrowser.disconnect();
        connectedBrowser = undefined;
        return false;
      } catch {
        await connectedBrowser?.disconnect();
        connectedBrowser = undefined;
        return false;
      }
    },
    {
      timeout: 30_000,
      timeoutMsg: 'Visible fixture game window did not become ready',
    }
  );
  if (!connectedBrowser || !fixtureGamePage) {
    throw new Error('Fixture game window is unavailable');
  }
  return { fixtureGameBrowser: connectedBrowser, fixtureGamePage };
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readHandoffLines() {
  return readFileSync(descriptor.handoffLogPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readPersistedDownload() {
  const persistenceDirectory = join(
    descriptor.applicationStateDirectory,
    'in-progress-downloads'
  );
  if (!existsSync(persistenceDirectory)) return undefined;
  const recordName = readdirSync(persistenceDirectory).find((name) =>
    name.endsWith('.json')
  );
  if (!recordName) return undefined;
  const path = join(persistenceDirectory, recordName);
  return {
    path,
    record: JSON.parse(readFileSync(path, 'utf8')) as {
      downloadInfo?: {
        name?: string;
        status?: string;
        files?: Array<{ path?: string }>;
      };
    },
  };
}

async function namedStep(
  page: Page,
  stepId: string,
  name: string,
  action: () => Promise<void>
) {
  writeEvent({ type: 'step.started', payload: { stepId, name } });
  try {
    await action();
    const screenshotPath = join(descriptor.artifactDirectory, `${stepId}.png`);
    await page.screenshot({ path: screenshotPath });
    writeEvent({
      type: 'artifact.created',
      payload: {
        artifactType: 'screenshot',
        path: relative(descriptor.sandboxDirectory, screenshotPath),
        stepId,
      },
    });
    writeEvent({
      type: 'step.completed',
      payload: { stepId, outcome: 'Passed' },
    });
  } catch (cause) {
    const failureScreenshotPath = join(
      descriptor.artifactDirectory,
      `${stepId}-failure.png`
    );
    await page.screenshot({ path: failureScreenshotPath }).catch(() => {});
    if (existsSync(failureScreenshotPath)) {
      writeEvent({
        type: 'artifact.created',
        payload: {
          artifactType: 'screenshot',
          path: relative(descriptor.sandboxDirectory, failureScreenshotPath),
          stepId,
        },
      });
    }
    writeEvent({
      type: 'step.completed',
      payload: {
        stepId,
        outcome: 'Failed',
        error: cause instanceof Error ? cause.message : String(cause),
        expectedProcessExit: true,
      },
    });
    throw cause;
  }
}

describe('packaged Golden Journey', () => {
  it('updates, completes first-run UI, installs the fixture, and shows one Library entry', async () => {
    let applicationBrowser: PuppeteerBrowser | undefined;
    let fixtureGameBrowser: PuppeteerBrowser | undefined;
    let fixtureGamePage: Page | undefined;
    let journeyCompleted = false;
    try {
      await browser.waitUntil(
        async () => await $('[aria-label="Update channel"]').isDisplayed(),
        {
          timeoutMsg: 'Packaged updater channel selection did not become ready',
        }
      );
      const stable = await $('aria/Stable');
      await stable.waitForClickable();
      if (process.env.OGI_E2E_FAIL_FIRST_ATTEMPT === '1' && attempt === 1) {
        const stepId = 'retry-policy-probe';
        writeEvent({
          type: 'step.started',
          payload: {
            stepId,
            name: 'Exercise the Product Journey automatic retry policy',
          },
        });
        const failureScreenshotPath = join(
          descriptor.artifactDirectory,
          `${stepId}-failure.png`
        );
        await browser.saveScreenshot(failureScreenshotPath);
        writeEvent({
          type: 'artifact.created',
          payload: {
            artifactType: 'screenshot',
            path: relative(descriptor.sandboxDirectory, failureScreenshotPath),
            stepId,
          },
        });
        const error =
          'Deliberate first-attempt Product Journey assertion failure';
        writeEvent({
          type: 'step.completed',
          payload: {
            stepId,
            outcome: 'Failed',
            error,
          },
        });
        return;
      }
      await stable.click();
      if (descriptor.offlineProductBehavior) {
        const updaterStepId = 'launch-offline-last-known-good';
        writeEvent({
          type: 'step.started',
          payload: {
            stepId: updaterStepId,
            name: 'Launch the Last Known-Good Installation while offline',
          },
        });
        await (
          await $('aria/Offline Last Known-Good Launched')
        ).waitForDisplayed({
          timeout: 30_000,
          timeoutMsg:
            'Updater did not visibly launch the Last Known-Good Installation offline',
        });
        await browser.waitUntil(
          () =>
            existsSync(descriptor.handoffLogPath) &&
            readFileSync(descriptor.handoffLogPath, 'utf8').includes(
              '"phase":"offline-last-known-good-launched"'
            ),
          {
            timeoutMsg:
              'Updater did not record the offline Last Known-Good launch',
          }
        );
        const updaterScreenshotPath = join(
          descriptor.artifactDirectory,
          `${updaterStepId}.png`
        );
        await browser.saveScreenshot(updaterScreenshotPath);
        writeEvent({
          type: 'artifact.created',
          payload: {
            artifactType: 'screenshot',
            path: relative(descriptor.sandboxDirectory, updaterScreenshotPath),
            stepId: updaterStepId,
          },
        });
        writeEvent({
          type: 'step.completed',
          payload: { stepId: updaterStepId, outcome: 'Passed' },
        });

        const offlineConnection = await connectToApplication();
        applicationBrowser = offlineConnection.applicationBrowser;
        const page = offlineConnection.applicationPage;
        const markerPath = join(
          descriptor.fixtureStateDirectory,
          'fixture-game-launch.json'
        );
        let fixtureGamePid = 0;

        await namedStep(
          page,
          'browse-library-offline',
          'Browse the installed Library with offline state visible',
          async () => {
            await page.waitForSelector('[aria-label="Library"]', {
              timeout: 30_000,
            });
            const searchState = await page.$eval(
              'input[placeholder="Search unavailable (offline)"]',
              (input) => ({
                disabled: (input as HTMLInputElement).disabled,
                placeholder: (input as HTMLInputElement).placeholder,
              })
            );
            if (
              !searchState.disabled ||
              searchState.placeholder !== 'Search unavailable (offline)'
            ) {
              throw new Error('Application did not present its offline state');
            }
            await page.click('[aria-label="Library"]');
            await page.waitForSelector('[data-library-item]', {
              timeout: 30_000,
            });
            const entries = await page.$$eval(
              '[data-library-item]',
              (items) =>
                items.filter((item) =>
                  item.textContent?.includes('Golden Journey Fixture')
                ).length
            );
            if (entries !== 1) {
              throw new Error(
                `Offline Library expected one fixture entry, received ${entries}`
              );
            }
          }
        );

        await namedStep(
          page,
          'launch-fixture-game-offline',
          'Launch the installed fixture game through Library UI while offline',
          async () => {
            await page.click('[data-library-item]');
            await waitForText(page, 'Golden Journey Fixture');
            await clickButtonText(page, 'PLAY');
            await browser.waitUntil(() => existsSync(markerPath), {
              timeout: 30_000,
              timeoutMsg:
                'Offline fixture game did not write its sandbox launch marker',
            });
            const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
              pid?: number;
              title?: string;
              visible?: boolean;
              platform?: string;
            };
            fixtureGamePid = Number(marker.pid);
            if (
              !Number.isInteger(fixtureGamePid) ||
              fixtureGamePid < 1 ||
              marker.title !== 'OpenGameInstaller Fixture Game' ||
              marker.visible !== true ||
              marker.platform !== descriptor.platform
            ) {
              throw new Error('Offline fixture game launch marker is invalid');
            }
            writeEvent({
              type: 'process.started',
              payload: { pid: fixtureGamePid, name: 'Fixture game' },
            });
            const gameConnection = await connectToFixtureGame();
            fixtureGameBrowser = gameConnection.fixtureGameBrowser;
            fixtureGamePage = gameConnection.fixtureGamePage;
            await fixtureGamePage.waitForSelector(
              'button[aria-label="Close Fixture Game"]',
              { timeout: 30_000 }
            );
            const gameScreenshotPath = join(
              descriptor.artifactDirectory,
              'launch-fixture-game-offline-window.png'
            );
            await fixtureGamePage.screenshot({ path: gameScreenshotPath });
            writeEvent({
              type: 'artifact.created',
              payload: {
                artifactType: 'screenshot',
                path: relative(descriptor.sandboxDirectory, gameScreenshotPath),
                stepId: 'launch-fixture-game-offline',
              },
            });
          }
        );

        await namedStep(
          page,
          'close-fixture-game-offline',
          'Close the offline fixture game through its visible UI',
          async () => {
            if (!fixtureGamePage) {
              throw new Error('Offline fixture game page disappeared');
            }
            await fixtureGamePage.click(
              'button[aria-label="Close Fixture Game"]'
            );
            await browser.waitUntil(() => !isProcessRunning(fixtureGamePid), {
              timeout: 30_000,
              timeoutMsg:
                'Offline fixture game process did not exit after visible close',
            });
            await fixtureGameBrowser?.disconnect().catch(() => {});
            fixtureGameBrowser = undefined;
            fixtureGamePage = undefined;
            writeEvent({
              type: 'process.stopped',
              payload: { pid: fixtureGamePid, leaked: false },
            });
          }
        );
        return;
      }
      if (descriptor.incrementalUpdate !== 'none') {
        const fallbackExpected = descriptor.incrementalUpdate !== 'valid';
        if (fallbackExpected) {
          const fallbackStepId = 'observe-full-download-fallback';
          writeEvent({
            type: 'step.started',
            payload: {
              stepId: fallbackStepId,
              name: 'Observe safe fallback from the rejected incremental patch',
            },
          });
          await (
            await $('aria/Falling Back to Full Download')
          ).waitForDisplayed({
            timeout: 30_000,
            timeoutMsg:
              'Updater did not visibly present the full-download fallback decision',
          });
          const fallbackScreenshotPath = join(
            descriptor.artifactDirectory,
            `${fallbackStepId}.png`
          );
          await browser.saveScreenshot(fallbackScreenshotPath);
          writeEvent({
            type: 'artifact.created',
            payload: {
              artifactType: 'screenshot',
              path: relative(
                descriptor.sandboxDirectory,
                fallbackScreenshotPath
              ),
              stepId: fallbackStepId,
            },
          });
          writeEvent({
            type: 'step.completed',
            payload: { stepId: fallbackStepId, outcome: 'Passed' },
          });
        }

        const resultStepId =
          descriptor.incrementalUpdate === 'valid'
            ? 'apply-incremental-update'
            : descriptor.incrementalUpdate === 'fallback-failure'
              ? 'preserve-last-known-good-after-fallback-failure'
              : 'complete-full-download-fallback';
        writeEvent({
          type: 'step.started',
          payload: {
            stepId: resultStepId,
            name:
              descriptor.incrementalUpdate === 'valid'
                ? 'Apply the compatible incremental update and reach Startup Health'
                : descriptor.incrementalUpdate === 'fallback-failure'
                  ? 'Preserve and relaunch Last Known-Good when fallback fails'
                  : 'Complete the full Verified Release fallback and reach Startup Health',
          },
        });
        try {
          if (descriptor.incrementalUpdate === 'fallback-failure') {
            await (
              await $('aria/Previous Installation Restored')
            ).waitForDisplayed({
              timeout: 30_000,
              timeoutMsg:
                'Updater did not visibly restore Last Known-Good after fallback failure',
            });
            await browser.waitUntil(
              () =>
                readFileSync(
                  join(descriptor.installationDirectory, 'version.txt'),
                  'utf8'
                ) === 'v4.0.0-e2e',
              {
                timeoutMsg:
                  'Failed full-download fallback did not preserve the incremental base installation',
              }
            );
            await browser.waitUntil(
              () =>
                readHandoffLines().some(
                  (entry) => entry.phase === 'last-known-good-launched'
                ),
              {
                timeoutMsg:
                  'Preserved Last Known-Good Installation did not relaunch after fallback failure',
              }
            );
          } else {
            await (await $('aria/Startup Health Confirmed')).waitForDisplayed({
              timeout: 60_000,
              timeoutMsg:
                'Incremental updater scenario did not reach Startup Health',
            });
            const connection = await connectToApplication();
            applicationBrowser = connection.applicationBrowser;
            await connection.applicationPage.waitForFunction(
              () => document.title === 'OpenGameInstaller',
              { timeout: 30_000 }
            );
            if (
              readFileSync(
                join(descriptor.installationDirectory, 'version.txt'),
                'utf8'
              ) !== 'v4.1.0-e2e'
            ) {
              throw new Error(
                'Incremental updater scenario did not install the current version'
              );
            }
          }
          const handoff = readHandoffLines();
          const phases = handoff.map((entry) => entry.phase);
          if (descriptor.incrementalUpdate === 'valid') {
            if (
              !phases.includes('incremental-selected') ||
              !phases.includes('incremental-applied') ||
              phases.includes('full-download-fallback-started')
            ) {
              throw new Error(
                'Valid incremental update evidence is incomplete'
              );
            }
          } else if (
            !phases.includes('incremental-rejected') ||
            !phases.includes('full-download-fallback-started')
          ) {
            throw new Error('Incremental fallback evidence is incomplete');
          }
          const resultScreenshotPath = join(
            descriptor.artifactDirectory,
            `${resultStepId}.png`
          );
          await browser.saveScreenshot(resultScreenshotPath);
          writeEvent({
            type: 'artifact.created',
            payload: {
              artifactType: 'screenshot',
              path: relative(descriptor.sandboxDirectory, resultScreenshotPath),
              stepId: resultStepId,
            },
          });
          writeEvent({
            type: 'step.completed',
            payload: { stepId: resultStepId, outcome: 'Passed' },
          });
          return;
        } catch (cause) {
          writeObservedRecoveryEvents();
          writeEvent({
            type: 'step.completed',
            payload: {
              stepId: resultStepId,
              outcome: 'Failed',
              error: cause instanceof Error ? cause.message : String(cause),
              expectedProcessExit: true,
            },
          });
          throw cause;
        }
      }
      if (descriptor.recoveryFailure !== 'none') {
        const stepId = `recover-${descriptor.recoveryFailure}`;
        writeEvent({
          type: 'step.started',
          payload: {
            stepId,
            name: `Recover from ${descriptor.recoveryFailure}`,
          },
        });
        try {
          await (
            await $('aria/Previous Installation Restored')
          ).waitForDisplayed({
            timeout: 30_000,
            timeoutMsg:
              'Updater did not visibly confirm Last Known-Good recovery',
          });
          await browser.waitUntil(
            () =>
              readFileSync(
                join(descriptor.installationDirectory, 'version.txt'),
                'utf8'
              ) === 'v0.0.1-e2e',
            {
              timeoutMsg:
                'Last Known-Good Installation was not restored after candidate failure',
            }
          );
          await browser.waitUntil(
            () =>
              readFileSync(descriptor.handoffLogPath, 'utf8').includes(
                '"phase":"last-known-good-launched"'
              ),
            {
              timeoutMsg:
                'Restored Last Known-Good Installation did not launch successfully',
            }
          );
          writeObservedRecoveryEvents();
          if (descriptor.recoveryFailure === 'pre-identity') {
            const interruption = readFileSync(descriptor.handoffLogPath, 'utf8')
              .split(/\r?\n/)
              .filter(Boolean)
              .map((line) => JSON.parse(line))
              .find(
                (handoff) =>
                  handoff.phase === 'pre-identity-interruption-injected'
              );
            if (
              !Number.isSafeInteger(interruption?.pid) ||
              interruption.proofBound !== true ||
              resolve(interruption.launcher) ===
                resolve(interruption.postExecExecutable) ||
              isProcessRunning(interruption.pid)
            ) {
              throw new Error(
                'Pre-identity AppImage exec transition was not proof-bound, discovered, and stopped'
              );
            }
          }
          if (
            ['immediate-root-exit', 'fork-during-scan', 'timeout'].includes(
              descriptor.recoveryFailure
            )
          ) {
            const handoffs = readFileSync(descriptor.handoffLogPath, 'utf8')
              .split(/\r?\n/)
              .filter(Boolean)
              .map((line) => JSON.parse(line));
            const descendant = handoffs.find(
              (handoff) =>
                handoff.phase === 'detached-candidate-descendant-launched'
            );
            const termination = handoffs.find(
              (handoff) => handoff.phase === 'owned-process-tree-terminated'
            );
            if (
              !Number.isSafeInteger(descendant?.pid) ||
              descendant.pid < 1 ||
              termination?.processTreeStopped !== true ||
              !Array.isArray(termination.terminatedPids) ||
              termination.terminatedPids.length <
                (descriptor.recoveryFailure === 'immediate-root-exit'
                  ? 1
                  : 2) ||
              !termination.terminatedPids.includes(descendant.pid) ||
              (descriptor.recoveryFailure !== 'immediate-root-exit' &&
                !termination.terminatedPids.includes(termination.rootPid)) ||
              (descriptor.recoveryFailure === 'fork-during-scan' &&
                termination.terminatedPids.length < 3)
            ) {
              throw new Error(
                'Detached candidate descendant was not included in verified owned-tree termination'
              );
            }
          }
          if (descriptor.recoveryFailure === 'replacement') {
            const replacementFailure = readFileSync(
              descriptor.handoffLogPath,
              'utf8'
            )
              .split(/\r?\n/)
              .filter(Boolean)
              .map((line) => JSON.parse(line))
              .find(
                (handoff) => handoff.phase === 'replacement-failure-injected'
              );
            if (
              replacementFailure?.workingVersion !== 'v4.1.0-e2e' ||
              replacementFailure.workingLauncherPresent !== false ||
              replacementFailure.candidateEntryPointPresent !== false
            ) {
              throw new Error(
                'Replacement failure did not prove recovery from a partially mutated working installation'
              );
            }
          }
          if (
            existsSync(descriptor.backupDirectory) ||
            existsSync(descriptor.stagingDirectory)
          ) {
            throw new Error(
              'Recovery left backup or staging content after restoration'
            );
          }
          const screenshotPath = join(
            descriptor.artifactDirectory,
            `${stepId}.png`
          );
          await browser.saveScreenshot(screenshotPath);
          writeEvent({
            type: 'artifact.created',
            payload: {
              artifactType: 'screenshot',
              path: relative(descriptor.sandboxDirectory, screenshotPath),
              stepId,
            },
          });
          writeEvent({
            type: 'step.completed',
            payload: { stepId, outcome: 'Passed' },
          });
          return;
        } catch (cause) {
          writeObservedRecoveryEvents();
          writeEvent({
            type: 'step.completed',
            payload: {
              stepId,
              outcome: 'Failed',
              error: cause instanceof Error ? cause.message : String(cause),
              expectedProcessExit: true,
            },
          });
          throw cause;
        }
      }
      await (await $('aria/Startup Health Confirmed')).waitForDisplayed({
        timeout: 60_000,
        timeoutMsg:
          'Updater did not confirm the packaged application Startup Health Signal',
      });
      await browser.waitUntil(() => existsSync(descriptor.startupHealthPath), {
        timeoutMsg: 'Startup Health Signal file was not observable',
      });

      const initialConnection = await connectToApplication();
      applicationBrowser = initialConnection.applicationBrowser;
      let page = initialConnection.applicationPage;

      await namedStep(
        page,
        'first-run-welcome',
        'Start first-run UI',
        async () => {
          await waitForText(page, 'Welcome to OpenGameInstaller');
          await clickButtonText(page, 'Get Started');
          await waitForText(page, 'Choose Your Theme');
          await clickButtonText(page, 'Continue');
          await waitForText(page, 'Install Tools');
        }
      );
      await namedStep(
        page,
        'first-run-tools',
        'Use sandboxed prerequisite state',
        async () => {
          await clickButtonText(page, 'Install');
          await waitForText(page, 'Torrenting');
          if (descriptor.deterministicTorrentInstallation) {
            await page.locator('aria/WebTorrent').click();
            await page.waitForFunction(
              () =>
                document
                  .querySelector('img[alt="WebTorrent"]')
                  ?.closest('button')
                  ?.getAttribute('aria-pressed') === 'true',
              { timeout: 30_000 }
            );
          }
          await clickButtonText(page, 'Continue');
          await waitForText(page, 'Download Location');
        }
      );
      await namedStep(
        page,
        'first-run-downloads',
        'Choose sandbox download location',
        async () => {
          await page.click('input[aria-label="Download location"]');
          await page.keyboard.type(
            join(descriptor.sandboxDirectory, 'downloads')
          );
          await clickButtonText(page, 'Continue');
          await waitForText(page, 'Community Addons');
        }
      );
      await namedStep(
        page,
        'first-run-addon',
        'Select E2E Fixture Addon',
        async () => {
          await waitForText(page, 'Steam Integration');
          await clickButtonText(page, 'Selected');
          await page.click('[aria-label="Custom addon repository"]');
          await page.click(
            'textarea[aria-label="Custom addon repository URLs"]'
          );
          await page.keyboard.type(
            `local@${join(descriptor.installationDirectory, 'app/ogi-e2e-fixture-addon')}`
          );
          await clickButtonText(page, 'Continue');
          if (descriptor.platform === 'linux') {
            await waitForText(page, 'SteamGridDB');
            await clickButtonText(page, 'Skip');
          }
          await waitForText(page, "You're all set!");
          await clickButtonText(page, 'Finish');
          await page.waitForSelector('[aria-label="Library"]', {
            timeout: 30_000,
          });
        }
      );

      await namedStep(
        page,
        'discover-fixture',
        'Discover fixture game',
        async () => {
          await page.click('[aria-label="Discovery"]');
          await page.waitForSelector('[aria-label="Golden Journey Fixture"]', {
            timeout: 30_000,
          });
          await page.focus('[aria-label="Golden Journey Fixture"]');
          await page.keyboard.press('Enter');
          await waitForText(
            page,
            descriptor.deterministicTorrentInstallation
              ? 'Fixture Service local tor'
              : 'Fixture Service direct do'
          );
        }
      );

      if (descriptor.gameDownloadRecovery) {
        const initialStepId = 'interrupt-initial-download';
        let partialDownloadPath = '';
        writeEvent({
          type: 'step.started',
          payload: {
            stepId: initialStepId,
            name: 'Interrupt the initial fixture download attempt',
          },
        });
        try {
          await clickButtonText(page, 'Download');
          await browser.waitUntil(
            () =>
              existsSync(
                join(
                  descriptor.fixtureStateDirectory,
                  'partial-download-ready.json'
                )
              ),
            {
              timeoutMsg:
                'Fixture Service did not expose the partial-download termination point',
            }
          );
          await page.click('[aria-label="Downloads"]');
          await page.waitForSelector('[aria-label="Pause Download"]', {
            timeout: 30_000,
          });
          await waitForText(page, 'Golden Journey Fixture');
          await browser.waitUntil(
            () => {
              const persisted = readPersistedDownload();
              partialDownloadPath =
                persisted?.record.downloadInfo?.files?.[0]?.path ?? '';
              return (
                persisted?.record.downloadInfo?.status === 'downloading' &&
                partialDownloadPath.length > 0 &&
                existsSync(partialDownloadPath) &&
                statSync(partialDownloadPath).size > 0 &&
                statSync(partialDownloadPath).size <
                  FIXTURE_GAME_CONTENT.byteLength
              );
            },
            {
              timeoutMsg:
                'The application did not persist genuine partial download state before termination',
            }
          );
          const screenshotPath = join(
            descriptor.artifactDirectory,
            `${initialStepId}.png`
          );
          await page.screenshot({ path: screenshotPath });
          writeEvent({
            type: 'artifact.created',
            payload: {
              artifactType: 'screenshot',
              path: relative(descriptor.sandboxDirectory, screenshotPath),
              stepId: initialStepId,
            },
          });
          writeEvent({
            type: 'step.completed',
            payload: { stepId: initialStepId, outcome: 'Passed' },
          });
        } catch (cause) {
          writeEvent({
            type: 'step.completed',
            payload: {
              stepId: initialStepId,
              outcome: 'Failed',
              error: cause instanceof Error ? cause.message : String(cause),
              expectedProcessExit: true,
            },
          });
          throw cause;
        }

        const initialLaunch = readHandoffLines().find(
          (handoff) => handoff.phase === 'application-launched'
        );
        const initialApplicationPid = Number(initialLaunch?.pid);
        if (
          !Number.isInteger(initialApplicationPid) ||
          initialApplicationPid < 1
        ) {
          throw new Error(
            'Initial packaged application PID was not observable'
          );
        }
        writeEvent({
          type: 'process.started',
          payload: {
            pid: initialApplicationPid,
            name: 'Initial packaged application download attempt',
          },
        });
        await applicationBrowser.disconnect();
        applicationBrowser = undefined;
        await terminatePidTree(initialApplicationPid);
        writeEvent({
          type: 'process.stopped',
          payload: { pid: initialApplicationPid, leaked: false },
        });

        const relaunchProcessLogPath = join(
          descriptor.artifactDirectory,
          'packaged-application-relaunch-process.log'
        );
        const relaunchProcessLog = createWriteStream(relaunchProcessLogPath, {
          flags: 'a',
        });
        const relaunchEnvironment = { ...process.env };
        delete relaunchEnvironment.NODE_OPTIONS;
        const relaunch = spawn(
          electronPath,
          [
            `--remote-debugging-port=${descriptor.automationPort}`,
            ...(descriptor.platform === 'linux' ? ['--no-sandbox'] : []),
            join(descriptor.installationDirectory, 'app/e2e-product-main.cjs'),
          ],
          {
            cwd: descriptor.installationDirectory,
            env: {
              ...relaunchEnvironment,
              OGI_RUN_DESCRIPTOR: descriptorPath,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        if (!relaunch.pid) {
          throw new Error(
            'Interrupted-download application relaunch did not start'
          );
        }
        relaunch.stdout?.pipe(relaunchProcessLog);
        relaunch.stderr?.pipe(relaunchProcessLog);
        appendFileSync(
          descriptor.handoffLogPath,
          `${JSON.stringify({
            timestamp: new Date().toISOString(),
            phase: 'application-relaunch-requested',
            pid: relaunch.pid,
          })}\n`
        );
        writeEvent({
          type: 'process.started',
          payload: {
            pid: relaunch.pid,
            name: 'Resumed packaged application download attempt',
          },
        });

        const resumedConnection = await connectToApplication();
        applicationBrowser = resumedConnection.applicationBrowser;
        page = resumedConnection.applicationPage;
        await namedStep(
          page,
          'present-interrupted-download',
          'Present interrupted fixture download after restart',
          async () => {
            await page.waitForSelector('[aria-label="Library"]', {
              timeout: 30_000,
            });
            await browser.waitUntil(
              () => {
                if (!existsSync(relaunchProcessLogPath)) return false;
                const log = readFileSync(relaunchProcessLogPath, 'utf8');
                return (
                  log.includes('Setting events-available') &&
                  log.includes('Config update received')
                );
              },
              {
                timeoutMsg:
                  'Relaunched fixture addon did not become configured for resume',
              }
            );
            await page.click('[aria-label="Downloads"]');
            await page.waitForSelector('[aria-label="Resume Download"]', {
              timeout: 30_000,
            });
            await waitForText(page, 'Golden Journey Fixture');
          }
        );
        await namedStep(
          page,
          'resume-interrupted-download',
          'Resume fixture download through visible UI',
          async () => {
            await page.click('[aria-label="Resume Download"]');
            const libraryPath = join(
              descriptor.applicationStateDirectory,
              'library/7001.json'
            );
            await browser.waitUntil(() => existsSync(libraryPath), {
              timeout: 60_000,
              timeoutMsg:
                'Resumed fixture download did not complete installation',
            });
            await browser.waitUntil(
              () => !existsSync(readPersistedDownload()?.path ?? ''),
              {
                timeoutMsg:
                  'Completed resumed download left stale persisted partial state',
              }
            );
            if (!partialDownloadPath) {
              throw new Error('Partial fixture download path was not recorded');
            }
            if (
              !readFileSync(partialDownloadPath).equals(FIXTURE_GAME_CONTENT)
            ) {
              throw new Error(
                'UI-driven resume did not produce the expected complete fixture bytes'
              );
            }
            const staleChunkFiles = readdirSync(
              dirname(partialDownloadPath)
            ).filter((name) => name.includes('.chunk'));
            if (staleChunkFiles.length > 0) {
              throw new Error(
                `Resumed download left stale chunk state: ${staleChunkFiles.join(', ')}`
              );
            }
            await page.click('[aria-label="Library"]');
            await page.waitForSelector('[data-library-item]', {
              timeout: 30_000,
            });
            const entries = await page.$$eval(
              '[data-library-item]',
              (items) =>
                items.filter(
                  (item) =>
                    item.textContent?.includes('Golden Journey Fixture') ||
                    item.querySelector('img[alt="Golden Journey Fixture"]')
                ).length
            );
            if (entries !== 1) {
              throw new Error(
                `Expected exactly one resumed Golden Journey Fixture Library entry, received ${entries}`
              );
            }
          }
        );
        return;
      }

      if (descriptor.deterministicTorrentInstallation) {
        await namedStep(
          page,
          'select-torrent-source',
          'Select the loopback torrent source',
          async () => {
            await waitForText(page, 'Fixture Service local tor');
            await waitForText(page, 'Torrent');
            await clickButtonText(page, 'Download');
            await waitForText(page, 'Downloading');
          }
        );
        await namedStep(
          page,
          'observe-torrent-progress',
          'Observe local torrent download progress',
          async () => {
            await page.click('[aria-label="Downloads"]');
            await waitForText(page, 'Golden Journey Fixture');
            await page.waitForFunction(
              () => {
                const progressLabels = [...document.querySelectorAll('*')]
                  .filter(
                    (element) => element.textContent?.trim() === 'Progress'
                  )
                  .map(
                    (element) => element.previousElementSibling?.textContent
                  );
                return progressLabels.some((value) => {
                  const progress = Number(value?.replace('%', ''));
                  return progress > 0 && progress < 100;
                });
              },
              { timeout: 30_000 }
            );
          }
        );
        await namedStep(
          page,
          'torrent-setup',
          'Complete fixture setup after torrent download',
          async () => {
            await waitForText(page, 'Setting up with ogi-e2e-fixture-addon');
            await browser.waitUntil(
              () =>
                existsSync(
                  join(
                    descriptor.applicationStateDirectory,
                    'library/7001.json'
                  )
                ),
              {
                timeoutMsg: 'Torrent setup did not create the Library record',
              }
            );
            await waitForText(page, 'Seeding');
          }
        );
        await namedStep(
          page,
          'verify-torrent-library',
          'Verify exact torrent payload and one Library entry',
          async () => {
            await page.click('[aria-label="Library"]');
            await page.waitForSelector('[data-library-item]', {
              timeout: 30_000,
            });
            const visibleItems = await page.$$eval(
              '[data-library-item]',
              (items) =>
                items.map((item) => ({
                  text: item.textContent ?? '',
                  imageAlts: Array.from(item.querySelectorAll('img')).map(
                    (image) => image.alt
                  ),
                }))
            );
            const launcherName =
              process.platform === 'win32'
                ? 'fixture-game.cmd'
                : 'fixture-game.sh';
            const libraryState = verifyExactTorrentLibraryState({
              sandboxDirectory: descriptor.sandboxDirectory,
              libraryDirectory: join(
                descriptor.applicationStateDirectory,
                'library'
              ),
              expectedInstallRoot: join(
                descriptor.sandboxDirectory,
                'downloads'
              ),
              fixtureBaseUrl: descriptor.fixtureBaseUrl,
              visibleItems,
              launcherName,
            });
            const { library } = libraryState;
            const installDirectory = library.cwd;
            const launcherBytes =
              expectedFixtureLauncherBytes(installDirectory);
            const installManifest = [
              ...FIXTURE_TORRENT_PAYLOAD_MANIFEST,
              {
                relativePath: launcherName,
                size: launcherBytes.byteLength,
                sha256: createHash('sha256')
                  .update(launcherBytes)
                  .digest('hex'),
              },
            ].sort((left, right) =>
              left.relativePath.localeCompare(right.relativePath)
            );
            verifyExactFixtureTree(installDirectory, installManifest);
            if (!readFileSync(library.launchExecutable).equals(launcherBytes)) {
              throw new Error('Torrent-installed launcher bytes are invalid');
            }
            const assertionPath = join(
              descriptor.artifactDirectory,
              'torrent-payload-manifest-assertion.json'
            );
            writeFileSync(
              assertionPath,
              JSON.stringify(
                {
                  version: 1,
                  visibleLibraryItems: libraryState.visibleLibraryItems,
                  libraryRecords: libraryState.libraryRecords,
                  libraryRecordPath: relative(
                    descriptor.applicationStateDirectory,
                    libraryState.libraryPath
                  ).replaceAll('\\', '/'),
                  installDirectory,
                  launchExecutable: library.launchExecutable,
                  files: installManifest,
                },
                null,
                2
              )
            );
            writeEvent({
              type: 'artifact.created',
              payload: {
                artifactType: 'torrent-payload-manifest-assertion',
                path: relative(descriptor.sandboxDirectory, assertionPath),
              },
            });
          }
        );
        return;
      }

      await namedStep(
        page,
        'install-fixture',
        'Select source and install fixture game',
        async () => {
          await clickButtonText(page, 'Download');
          await waitForText(page, 'View in Library');
          await clickButtonText(page, 'View in Library');
          await page.waitForSelector('[data-library-item]', {
            timeout: 30_000,
          });
        }
      );

      await namedStep(
        page,
        'verify-library',
        'Verify exactly one fixture in Library',
        async () => {
          const entries = await page.$$eval(
            '[data-library-item]',
            (items) =>
              items.filter(
                (item) =>
                  item.textContent?.includes('Golden Journey Fixture') ||
                  item.querySelector('img[alt="Golden Journey Fixture"]')
              ).length
          );
          if (entries !== 1) {
            throw new Error(
              `Expected exactly one Golden Journey Fixture Library entry, received ${entries}`
            );
          }
          const libraryPath = join(
            descriptor.applicationStateDirectory,
            'library/7001.json'
          );
          const library = JSON.parse(readFileSync(libraryPath, 'utf8'));
          if (
            library.name !== 'Golden Journey Fixture' ||
            library.addonsource !== 'ogi-e2e-fixture-addon'
          ) {
            throw new Error('Fixture Library record is invalid');
          }
        }
      );

      if (descriptor.fixtureGameLifecycle) {
        const libraryPath = join(
          descriptor.applicationStateDirectory,
          'library/7001.json'
        );
        const installedLibrary = JSON.parse(
          readFileSync(libraryPath, 'utf8')
        ) as {
          installDirectory?: string;
          installRoot?: string;
          launchExecutable?: string;
        };
        if (
          !installedLibrary.installDirectory ||
          !installedLibrary.installRoot ||
          !installedLibrary.launchExecutable
        ) {
          throw new Error('Fixture Library record has no lifecycle ownership');
        }
        const installDirectory = installedLibrary.installDirectory;
        const installRoot = installedLibrary.installRoot;
        const launcherContents = readFileSync(
          installedLibrary.launchExecutable,
          'utf8'
        );
        if (
          !launcherContents.includes('electron') ||
          /(^|[\s"'])bun(?:\.exe)?([\s"']|$)/i.test(launcherContents) ||
          /(^|[\s"'])node(?:\.exe)?([\s"']|$)/i.test(launcherContents)
        ) {
          throw new Error('Fixture game launcher depends on host Bun or Node');
        }
        if (
          relative(resolve(installRoot), resolve(installDirectory)).startsWith(
            '..'
          )
        ) {
          throw new Error('Fixture install ownership is invalid');
        }
        if (
          !readFileSync(join(installDirectory, 'golden-journey.txt')).equals(
            FIXTURE_GAME_CONTENT
          )
        ) {
          throw new Error('Installed fixture game payload bytes are invalid');
        }
        const markerPath = join(
          descriptor.fixtureStateDirectory,
          'fixture-game-launch.json'
        );
        const sentinelPath = join(
          descriptor.sandboxDirectory,
          'downloads/unrelated-sentinel.txt'
        );
        const sentinelContents = readFileSync(sentinelPath, 'utf8');
        let fixtureGamePid = 0;

        await namedStep(
          page,
          'launch-fixture-game',
          'Launch the visible fixture game through Library UI',
          async () => {
            await page.click('[data-library-item]');
            await waitForText(page, 'Golden Journey Fixture');
            await clickButtonText(page, 'PLAY');
            await browser.waitUntil(() => existsSync(markerPath), {
              timeout: 30_000,
              timeoutMsg:
                'Fixture game did not write its sandbox launch marker',
            });
            const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as {
              pid?: number;
              title?: string;
              visible?: boolean;
              platform?: string;
            };
            fixtureGamePid = Number(marker.pid);
            if (
              !Number.isInteger(fixtureGamePid) ||
              fixtureGamePid < 1 ||
              marker.title !== 'OpenGameInstaller Fixture Game' ||
              marker.visible !== true ||
              marker.platform !== descriptor.platform
            ) {
              throw new Error('Fixture game launch marker is invalid');
            }
            writeEvent({
              type: 'process.started',
              payload: { pid: fixtureGamePid, name: 'Fixture game' },
            });
            const gameConnection = await connectToFixtureGame();
            fixtureGameBrowser = gameConnection.fixtureGameBrowser;
            fixtureGamePage = gameConnection.fixtureGamePage;
            await fixtureGamePage.waitForSelector(
              'button[aria-label="Close Fixture Game"]',
              { timeout: 30_000 }
            );
            const gameScreenshotPath = join(
              descriptor.artifactDirectory,
              'launch-fixture-game-window.png'
            );
            await fixtureGamePage.screenshot({ path: gameScreenshotPath });
            writeEvent({
              type: 'artifact.created',
              payload: {
                artifactType: 'screenshot',
                path: relative(descriptor.sandboxDirectory, gameScreenshotPath),
                stepId: 'launch-fixture-game',
              },
            });
          }
        );

        await namedStep(
          page,
          'close-fixture-game',
          'Close the fixture game and return control to the application',
          async () => {
            if (!fixtureGamePage) {
              throw new Error('Fixture game page disappeared');
            }
            await fixtureGamePage.click(
              'button[aria-label="Close Fixture Game"]'
            );
            await browser.waitUntil(() => !isProcessRunning(fixtureGamePid), {
              timeout: 30_000,
              timeoutMsg:
                'Fixture game process did not exit after visible close',
            });
            await fixtureGameBrowser?.disconnect().catch(() => {});
            fixtureGameBrowser = undefined;
            fixtureGamePage = undefined;
            await browser.waitUntil(
              async () =>
                await page.evaluate(() =>
                  [...document.querySelectorAll('button')].some(
                    (button) => button.textContent?.trim() === 'PLAY'
                  )
                ),
              {
                timeout: 30_000,
                timeoutMsg:
                  'Application did not regain fixture game launch control',
              }
            );
            writeEvent({
              type: 'process.stopped',
              payload: { pid: fixtureGamePid, leaked: false },
            });
          }
        );

        const generalConfigPath = join(
          descriptor.applicationStateDirectory,
          'config/option/general.json'
        );
        const changedDownloadRoot = join(
          descriptor.sandboxDirectory,
          'changed-download-root'
        );
        mkdirSync(changedDownloadRoot, { recursive: true });
        const generalConfig = JSON.parse(
          readFileSync(generalConfigPath, 'utf8')
        );
        writeFileSync(
          generalConfigPath,
          JSON.stringify({
            ...generalConfig,
            fileDownloadLocation: changedDownloadRoot,
          })
        );

        await namedStep(
          page,
          'confirm-fixture-uninstall',
          'Confirm permanent fixture file deletion through visible UI',
          async () => {
            await clickButtonText(page, 'Settings');
            await page.waitForSelector(
              '[aria-label="Configure Golden Journey Fixture"]',
              { timeout: 30_000 }
            );
            await clickButtonText(page, 'Manage Game Removal');
            await page.waitForSelector(
              '[aria-label="Confirm removal of Golden Journey Fixture"]',
              { timeout: 30_000 }
            );
            await waitForText(page, 'Delete files and remove from Library');
            await waitForText(page, 'Remove from Library only');
            await waitForText(page, installDirectory);
            await assertAccessibleSurface(
              page,
              '[aria-label="Confirm removal of Golden Journey Fixture"]',
              'Fixture uninstall confirmation'
            );
            if (!existsSync(installDirectory) || !existsSync(libraryPath)) {
              throw new Error(
                'Opening uninstall confirmation changed fixture state'
              );
            }
          }
        );

        await namedStep(
          page,
          'refuse-unowned-fixture-delete',
          'Present an ownership refusal visibly without changing game state',
          async () => {
            writeFileSync(
              libraryPath,
              JSON.stringify({
                ...installedLibrary,
                installRoot: changedDownloadRoot,
              })
            );
            await clickButtonText(page, 'Delete Files and Remove from Library');
            await waitForText(
              page,
              'Refusing to delete files outside the directory that owned this install'
            );
            await assertAccessibleSurface(
              page,
              '[aria-label="Confirm removal of Golden Journey Fixture"]',
              'Fixture uninstall refusal'
            );
            if (!existsSync(installDirectory) || !existsSync(libraryPath)) {
              throw new Error('Refused uninstall changed fixture state');
            }
            writeFileSync(libraryPath, JSON.stringify(installedLibrary));
          }
        );

        await namedStep(
          page,
          'uninstall-fixture-game',
          'Uninstall the fixture game through confirmed visible UI',
          async () => {
            await clickButtonText(page, 'Delete Files and Remove from Library');
            await waitForText(page, 'No games in library');
            if (existsSync(installDirectory)) {
              throw new Error('Fixture game files remain after uninstall');
            }
            if (existsSync(libraryPath)) {
              throw new Error('Fixture Library entry remains after uninstall');
            }
            if (readFileSync(sentinelPath, 'utf8') !== sentinelContents) {
              throw new Error('Uninstall changed unrelated sandbox data');
            }
          }
        );
      }
      journeyCompleted = true;
    } finally {
      await disconnectProductJourneyBrowser(fixtureGameBrowser).catch(() => {});
      if (journeyCompleted) {
        await completeProductJourneyAutomation(
          applicationBrowser,
          descriptor.fixtureStateDirectory
        ).catch(() => {});
      } else {
        await disconnectProductJourneyBrowser(applicationBrowser).catch(
          () => {}
        );
      }
    }
  });
});
