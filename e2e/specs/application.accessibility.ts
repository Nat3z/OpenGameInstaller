import { $, browser } from '@wdio/globals';
import {
  clientOptionsIncludesSteamGridDb,
  getAccessibilityState,
  oobeIncludesSteamGridDb,
} from '../accessibility-states';

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

async function scan(label: string, rootSelector?: string) {
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
    [string | undefined]
  >((selector, done) => {
    const root = selector ? document.querySelector(selector) : document;
    if (!root) {
      done({ error: `Accessibility scan root not found: ${selector}` });
      return;
    }
    (
      window as typeof window & {
        axe: {
          run: (
            root: Document | Element,
            callback: (
              error: Error | null,
              results?: { violations: AxeViolation[] }
            ) => void
          ) => void;
        };
      }
    ).axe.run(root, (error, results) => {
      done(
        error
          ? { error: error.message }
          : { violations: results?.violations ?? [] }
      );
    });
  }, rootSelector);
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

async function dismissBlockingNotifications() {
  await browser.execute(() => {
    for (const notification of document.querySelectorAll(
      '.notification-card, [role="alert"]'
    )) {
      notification.remove();
    }
  });
}

async function expectAttribute(
  selector: string,
  attribute: string,
  expected: string
) {
  const control = await $(selector);
  await control.waitForDisplayed();
  const actual = await control.getAttribute(attribute);
  if (actual !== expected) {
    throw new Error(
      `${selector} expected ${attribute}="${expected}", received "${actual}"`
    );
  }
}

describe('application accessibility', () => {
  const state = getAccessibilityState();

  before(async () => {
    await browser.waitUntil(
      async () => (await browser.getTitle()) === 'OpenGameInstaller',
      {
        timeout: 30_000,
        timeoutMsg: `OpenGameInstaller window did not become ready (title: ${await browser.getTitle()}, URL: ${await browser.getUrl()})`,
      }
    );
    await browser.waitUntil(() => browser.execute(() => 'axe' in window), {
      timeoutMsg: 'Axe did not load into the application renderer',
    });
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
      await expectAttribute('aria/Setup progress', 'value', '1');
      await expectAttribute(
        'button[aria-pressed="true"]',
        'aria-pressed',
        'true'
      );
      await scan('Download provider');
      await activateByText('Continue');
      await waitForHeading('Download Location');
      await expectAttribute('aria/Setup progress', 'value', '2');
      await scan('Download location');
      const location = await $('aria/Download location');
      await location.waitForClickable();
      await location.click();
      await location.addValue(process.env.OGI_DIRECTORY ?? '');
      await activateByText('Continue');
      await waitForHeading('Community Addons');
      await scan('Community addons');
      await activateByText('Continue');
      if (oobeIncludesSteamGridDb()) {
        await waitForHeading('SteamGridDB');
        await scan('SteamGridDB');
        await activateByText('Skip');
      }
      await waitForHeading("You're all set!");
      await scan('Setup complete');
      return;
    }

    if (state === 'main') {
      await (await $('aria/Library')).waitForDisplayed();
      await scan('Library');

      await activate('Discovery');
      await scan('Discovery');
      await activate('Addon Settings');
      await scan('Addon Settings');
      await activate('Client Options');
      await activate('General');
      await scan('Client Options');

      await dismissBlockingNotifications();
      const torrentClient = await $('button[aria-label^="Torrent Client:"]');
      await torrentClient.waitForClickable();
      await torrentClient.click();
      await browser.waitUntil(
        async () =>
          (await torrentClient.getAttribute('aria-expanded')) === 'true'
      );
      const selectedTorrentClient = await $(
        '[role="option"][aria-selected="true"]'
      );
      await selectedTorrentClient.waitForDisplayed();
      await browser.keys('ArrowDown');
      await browser.waitUntil(
        async () => await selectedTorrentClient.isFocused(),
        {
          timeout: 5_000,
          timeoutMsg: 'ArrowDown did not focus the selected dropdown option',
        }
      );
      await scan('Open torrent client dropdown');
      await browser.keys('Escape');
      await browser.waitUntil(
        async () =>
          (await torrentClient.getAttribute('aria-expanded')) === 'false'
      );

      if (clientOptionsIncludesSteamGridDb()) {
        const changeSteamGridDBKey = await $(
          'aria/Change SteamGridDB API Key'
        );
        await changeSteamGridDBKey.click();
        const dialog = await $(
          '[role="dialog"][aria-label="SteamGridDB API key"]'
        );
        await dialog.waitForDisplayed();
        const dialogOwnsFocus = await browser.execute(
          (selector) =>
            document.querySelector(selector)?.contains(document.activeElement) ??
            false,
          '[role="dialog"][aria-label="SteamGridDB API key"]'
        );
        if (!dialogOwnsFocus) {
          throw new Error('SteamGridDB dialog did not receive focus');
        }
        await scan(
          'SteamGridDB dialog',
          '[role="dialog"][aria-label="SteamGridDB API key"]'
        );
        await activateByText('Cancel');
        await dialog.waitForDisplayed({ reverse: true });
        if (!(await changeSteamGridDBKey.isFocused())) {
          throw new Error('Dialog did not restore focus to its trigger');
        }
      }

      await activate('Downloads');
      await scan('Downloads');

      const notifications = await $('button[aria-label="Notifications"]');
      await notifications.waitForClickable();
      await notifications.click();
      await (await $('button[aria-label="Close panel"]')).waitForDisplayed();
      await scan('Notifications');
      return;
    }

    throw new Error(`Unhandled accessibility state: ${state}`);
  });
});
