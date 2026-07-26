import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { $, browser } from '@wdio/globals';
import { makeRunEventWriter, replayRunEventLog } from '../src/run-events';
import { readUpdaterRunDescriptor } from '../src/updater-scenario';

const descriptorPath = process.env.OGI_RUN_DESCRIPTOR;
if (!descriptorPath) throw new Error('OGI_RUN_DESCRIPTOR is required');
const descriptor = readUpdaterRunDescriptor(descriptorPath);
const writeEvent = makeRunEventWriter(
  descriptor.eventLogPath,
  descriptor.runId,
  replayRunEventLog(descriptor.eventLogPath).lastSequence
);
const stepId = 'select-stable-fixture-release';

describe('deterministic Updater Scenario', () => {
  it('selects Stable and reads release metadata from the Fixture Service', async () => {
    const attempt = Number(process.env.OGI_SCENARIO_ATTEMPT ?? '1');
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > 2) {
      throw new Error('OGI_SCENARIO_ATTEMPT must be 1 or 2');
    }
    writeEvent({
      type: 'step.started',
      payload: { stepId, name: 'Select Stable fixture release' },
    });
    try {
      await browser.waitUntil(
        async () =>
          (await browser.getTitle()) === 'OpenGameInstaller Updater' &&
          (await $('[aria-label="Update channel"]').isDisplayed()),
        {
          timeout: 30_000,
          timeoutMsg: 'Updater channel selection did not become ready',
        }
      );
      const stable = await $('aria/Stable');
      await stable.waitForClickable({
        timeoutMsg: 'Stable update channel did not become clickable',
      });
      await stable.click();
      const readyHeading = await $('aria/Fixture Release Ready');
      await readyHeading.waitForDisplayed({
        timeout: 30_000,
        timeoutMsg:
          'Updater did not present release metadata from the Fixture Service',
      });
      await browser.waitUntil(
        async () =>
          (await $('#status-detail').getText()) ===
          'v9.9.9 from Fixture Service',
        {
          timeout: 30_000,
          timeoutMsg: 'Updater did not present the fixture release version',
        }
      );
      await browser.waitUntil(
        () =>
          existsSync(descriptor.nativeDialogLogPath) &&
          readFileSync(descriptor.nativeDialogLogPath, 'utf8').includes(
            'choose-stable-channel'
          ),
        {
          timeout: 30_000,
          timeoutMsg:
            'Queued native-dialog request was not recorded for the Stable UI action',
        }
      );
      const screenshotPath = join(
        descriptor.artifactDirectory,
        `attempt-${attempt}-fixture-release-ready.png`
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
      if (process.env.OGI_E2E_FAIL_FIRST_ATTEMPT === '1' && attempt === 1) {
        throw new Error('Deliberate first-attempt Updater assertion failure');
      }
      writeEvent({
        type: 'step.completed',
        payload: { stepId, outcome: 'Passed' },
      });
    } catch (cause) {
      const failurePath = join(
        descriptor.artifactDirectory,
        `attempt-${attempt}-failure.png`
      );
      try {
        await browser.saveScreenshot(failurePath);
        writeEvent({
          type: 'artifact.created',
          payload: {
            artifactType: 'screenshot',
            path: relative(descriptor.sandboxDirectory, failurePath),
            stepId,
          },
        });
      } catch {
        // A session-start failure can make screenshot capture unavailable.
      }
      const deliberateAssertion =
        process.env.OGI_E2E_FAIL_FIRST_ATTEMPT === '1' && attempt === 1;
      writeEvent({
        type: 'step.completed',
        payload: {
          stepId,
          outcome: 'Failed',
          error: cause instanceof Error ? cause.message : String(cause),
          ...(!deliberateAssertion ? { expectedProcessExit: true } : {}),
        },
      });
      if (!deliberateAssertion) throw cause;
    }
  });
});
