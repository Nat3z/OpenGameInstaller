import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { $, browser } from '@wdio/globals';
import {
  connect,
  type Page,
  type Browser as PuppeteerBrowser,
} from 'puppeteer-core';
import { readPackagedHandoffRunDescriptor } from '../src/packaged-handoff';
import { makeRunEventWriter, replayRunEventLog } from '../src/run-events';

const descriptorPath = process.env.OGI_RUN_DESCRIPTOR;
if (!descriptorPath) throw new Error('OGI_RUN_DESCRIPTOR is required');
const descriptor = readPackagedHandoffRunDescriptor(descriptorPath);
const writeEvent = makeRunEventWriter(
  descriptor.eventLogPath,
  descriptor.runId,
  replayRunEventLog(descriptor.eventLogPath).lastSequence
);

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
      },
    });
    throw cause;
  }
}

describe('packaged Golden Journey', () => {
  it('updates, completes first-run UI, installs the fixture, and shows one Library entry', async () => {
    let applicationBrowser: PuppeteerBrowser | undefined;
    try {
      await browser.waitUntil(
        async () => await $('[aria-label="Update channel"]').isDisplayed(),
        {
          timeoutMsg: 'Packaged updater channel selection did not become ready',
        }
      );
      const stable = await $('aria/Stable');
      await stable.waitForClickable();
      await stable.click();
      await (await $('aria/Startup Health Confirmed')).waitForDisplayed({
        timeout: 60_000,
        timeoutMsg:
          'Updater did not confirm the packaged application Startup Health Signal',
      });
      await browser.waitUntil(() => existsSync(descriptor.startupHealthPath), {
        timeoutMsg: 'Startup Health Signal file was not observable',
      });

      let applicationPage: Page | undefined;
      await browser.waitUntil(
        async () => {
          try {
            applicationBrowser = await connect({
              browserURL: `http://127.0.0.1:${descriptor.automationPort}`,
            });
            for (const page of await applicationBrowser.pages()) {
              if ((await page.title()) === 'OpenGameInstaller') {
                applicationPage = page;
                break;
              }
            }
            return applicationPage !== undefined;
          } catch {
            await applicationBrowser?.disconnect();
            applicationBrowser = undefined;
            return false;
          }
        },
        {
          timeout: 30_000,
          timeoutMsg:
            'Automation did not reconnect to the updater-launched application',
        }
      );
      if (!applicationPage) {
        throw new Error('Updater-launched application page is unavailable');
      }
      const page = applicationPage;

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
          await clickButtonText(page, 'Continue');
          await waitForText(page, 'Download Location');
        }
      );
      await namedStep(
        page,
        'first-run-downloads',
        'Choose sandbox download location',
        async () => {
          await page.$eval(
            'input[aria-label="Download location"]',
            (input, value) => {
              const field = input as HTMLInputElement;
              field.value = value;
              field.dispatchEvent(new Event('input', { bubbles: true }));
            },
            join(descriptor.sandboxDirectory, 'downloads')
          );
          await page.focus('input[aria-label="Download location"]');
          await page.keyboard.press('Tab');
          await page.keyboard.press('Tab');
          await page.keyboard.press('Enter');
          await page.waitForSelector('.oobe-community-title', {
            timeout: 30_000,
          });
        }
      );
      await namedStep(
        page,
        'first-run-addon',
        'Select E2E Fixture Addon',
        async () => {
          await page.click('.oobe-custom-addon-panel summary');
          await page.type(
            'textarea[aria-label="Custom addon repository URLs"]',
            `local@${join(
              descriptor.installationDirectory,
              'app/e2e-fixture-addon'
            )}`
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
          await page.click('[aria-label="Golden Journey Fixture"]');
          await waitForText(page, 'Fixture Service direct do');
        }
      );

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
    } finally {
      await applicationBrowser?.disconnect();
    }
  });
});
