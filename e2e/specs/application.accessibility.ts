import axe from 'axe-core';
import { $, browser } from '@wdio/globals';

type AxeViolation = {
  id: string;
  impact?: string | null;
  help: string;
  nodes: Array<{ target: unknown; failureSummary?: string }>;
};

function formatViolations(violations: AxeViolation[]) {
  return violations
    .map(
      (violation) =>
        `${violation.impact ?? 'unknown'}: ${violation.id} — ${violation.help}\n${violation.nodes
          .map(
            (node) =>
              `  ${JSON.stringify(node.target)}: ${node.failureSummary ?? 'No failure summary'}`
          )
          .join('\n')}`
    )
    .join('\n\n');
}

async function scan(label: string) {
  console.log(`Scanning ${label}`);
  await browser.execute(() => {
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getComputedTiming().endTime !== Infinity) {
        animation.finish();
      }
    }
  });
  const response = await browser.executeAsync<
    { error?: string; violations?: AxeViolation[] },
    []
  >((done) => {
    (
      window as typeof window & {
        axe: {
          run: (
            root: Document,
            callback: (
              error: Error | null,
              results?: { violations: AxeViolation[] }
            ) => void
          ) => void;
        };
      }
    ).axe.run(document, (error, results) => {
      done(
        error
          ? { error: error.message }
          : { violations: results?.violations ?? [] }
      );
    });
  });
  if (response.error) {
    throw new Error(`${label} accessibility scan failed: ${response.error}`);
  }
  const violations = response.violations ?? [];
  if (violations.length > 0) {
    throw new Error(
      `${label} has accessibility violations:\n${formatViolations(violations)}`
    );
  }
  console.log(`Passed ${label}`);
}

async function activate(name: string) {
  const control = await $(`aria/${name}`);
  await control.waitForClickable();
  await control.click();
}

async function activateByText(name: string) {
  console.log(`Activating ${name}`);
  const control = await $(`button=${name}`);
  await control.waitForClickable();
  await control.click();
}

async function waitForHeading(name: string) {
  const heading = await $(`h1=${name}`);
  await heading.waitForDisplayed();
}

describe('application accessibility', () => {
  const state = process.env.OGI_ACCESSIBILITY_STATE ?? 'welcome';

  before(async () => {
    await browser.waitUntil(
      async () => (await browser.getTitle()) === 'OpenGameInstaller',
      {
        timeout: 30_000,
        timeoutMsg: `OpenGameInstaller window did not become ready (title: ${await browser.getTitle()}, URL: ${await browser.getUrl()})`,
      }
    );
    await browser.execute(axe.source);
  });

  it('has no automated accessibility violations in user-visible states', async () => {
    if (state === 'welcome') {
      await waitForHeading('Welcome to OpenGameInstaller');
      await scan('Welcome');
      await activateByText('Get Started');
      await waitForHeading('Choose Your Theme');
      await scan('Theme selection');
      await activateByText('Continue');
      await waitForHeading('Install Tools');
      await scan('Tool installation');
      return;
    }

    if (state === 'oobe-resume') {
      await waitForHeading('Torrenting');
      await scan('Download provider');
      await activateByText('Continue');
      await waitForHeading('Download Location');
      await scan('Download location');
      const location = await $('input[data-dwloc]');
      await location.setValue(process.env.OGI_DIRECTORY ?? '');
      await activateByText('Continue');
      await waitForHeading('Community Addons');
      await scan('Community addons');
      await activateByText('Continue');
      await waitForHeading('SteamGridDB');
      await scan('SteamGridDB');
      await activateByText('Skip');
      await waitForHeading("You're all set!");
      await scan('Setup complete');
      return;
    }

    await (await $('aria/Library')).waitForDisplayed();
    await scan('Library');

    for (const view of [
      'Discovery',
      'Addon Settings',
      'Client Options',
      'Downloads',
    ]) {
      await activate(view);
      await scan(view);
    }

    await activate('Notifications');
    await (await $('aria/Close panel')).waitForDisplayed();
    await scan('Notifications');
  });
});
