import { join, relative } from 'node:path';
import { $, browser } from '@wdio/globals';
import { readApplicationRunDescriptor } from '../src/application-scenario';
import { makeRunEventWriter, replayRunEventLog } from '../src/run-events';

const descriptorPath = process.env.OGI_RUN_DESCRIPTOR;
if (!descriptorPath) throw new Error('OGI_RUN_DESCRIPTOR is required');
const descriptor = readApplicationRunDescriptor(descriptorPath);
const writeEvent = makeRunEventWriter(
  descriptor.eventLogPath,
  descriptor.runId,
  replayRunEventLog(descriptor.eventLogPath).lastSequence
);
const stepId = 'navigate-discovery';
describe('observable Application Scenario', () => {
  it('navigates to Discovery through the visible accessible control', async () => {
    const attempt = Number(process.env.OGI_SCENARIO_ATTEMPT ?? '1');
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > 2) {
      throw new Error('OGI_SCENARIO_ATTEMPT must be 1 or 2');
    }
    writeEvent({
      type: 'step.started',
      payload: { stepId, name: 'Navigate to Discovery' },
    });
    try {
      await browser.waitUntil(
        async () =>
          (await browser.getTitle()) === 'OpenGameInstaller' &&
          (await $('aria/Library').isDisplayed()),
        {
          timeout: 30_000,
          timeoutMsg:
            'Application Library did not become ready for visible navigation',
        }
      );
      const discovery = await $('aria/Discovery');
      await discovery.waitForClickable({
        timeoutMsg: 'Discovery navigation control did not become clickable',
      });
      await discovery.click();
      await browser.waitUntil(
        async () => (await discovery.getAttribute('aria-current')) === 'page',
        {
          timeoutMsg:
            'Discovery did not become the current visible application view',
        }
      );
      await (await $('aria/No catalogs available')).waitForDisplayed({
        timeoutMsg: 'Discovery empty state did not become visible',
      });
      await browser.execute(() => {
        for (const animation of document.getAnimations()) {
          if (animation.effect?.getComputedTiming().endTime !== Infinity) {
            animation.finish();
          }
        }
      });
      const screenshotPath = join(
        descriptor.artifactDirectory,
        descriptor.mode === 'flaky-once'
          ? `attempt-${attempt}-navigate-discovery.png`
          : 'navigate-discovery.png'
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
      if (descriptor.mode === 'assertion-failure') {
        throw new Error('Deliberate Application Scenario assertion failure');
      }
      if (descriptor.mode === 'flaky-once' && attempt === 1) {
        throw new Error('Deliberate first-attempt failure for automatic retry');
      }
      writeEvent({
        type: 'step.completed',
        payload: { stepId, outcome: 'Passed' },
      });
    } catch (cause) {
      const failurePath = join(
        descriptor.artifactDirectory,
        descriptor.mode === 'flaky-once'
          ? `attempt-${attempt}-failure.png`
          : 'failure.png'
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
      const error = cause instanceof Error ? cause.message : String(cause);
      const deliberateAssertion =
        descriptor.mode === 'assertion-failure' ||
        (descriptor.mode === 'flaky-once' && attempt === 1);
      writeEvent({
        type: 'step.completed',
        payload: {
          stepId,
          outcome: 'Failed',
          error,
          ...(!deliberateAssertion ? { expectedProcessExit: true } : {}),
        },
      });
      if (!deliberateAssertion) throw cause;
    }
  });
});
