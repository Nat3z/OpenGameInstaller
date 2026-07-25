import { $, browser } from '@wdio/globals';
import { getUpdaterAccessibilityState } from '../updater-accessibility-states';

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

async function expectAttribute(
  selector: string,
  attribute: string,
  expected: string,
  waitForVisible = true
) {
  const element = await $(selector);
  if (waitForVisible) await element.waitForDisplayed();
  const actual = await element.getAttribute(attribute);
  if (actual !== expected) {
    throw new Error(
      `${selector} expected ${attribute}="${expected}", received "${actual}"`
    );
  }
}

async function expectTextContent(selector: string, expected: string) {
  const element = await $(selector);
  const actual = await element.getProperty('textContent');
  if (actual !== expected) {
    throw new Error(
      `${selector} expected text content "${expected}", received "${actual}"`
    );
  }
}

async function expectFocused(selector: string, description: string) {
  const element = await $(selector);
  if (!(await element.isFocused())) {
    throw new Error(`${description} did not receive focus`);
  }
}

async function chooseStableChannel() {
  const stable = await $('aria/Stable');
  await stable.waitForClickable();
  await stable.click();
}

describe('updater accessibility', () => {
  const state = getUpdaterAccessibilityState();

  before(async () => {
    await browser.waitUntil(
      async () =>
        (await browser.getTitle()) === 'OpenGameInstaller Updater' &&
        (await $('[aria-label="Update channel"]').isDisplayed()),
      {
        timeoutMsg: 'Updater channel selection did not become ready',
      }
    );
    await browser.waitUntil(() => browser.execute(() => 'axe' in window), {
      timeoutMsg: 'Axe did not load into the updater renderer',
    });
  });

  it('exposes stable accessible semantics across updater states', async () => {
    if (state === 'selection') {
      const stable = await $('aria/Stable');
      await stable.waitForClickable();
      await expectFocused('aria/Stable', 'Default update channel');
      await scan('Channel selection');

      await (await $('aria/Bleeding Edge')).click();
      const branch = await $('[aria-label="Branch"]');
      await branch.waitForEnabled({
        timeoutMsg: 'Bleeding Edge branch selection did not become enabled',
      });
      await expectFocused('aria/Back', 'Bleeding Edge back control');
      await (
        await $('aria/Optional commit SHA, branch, or tag')
      ).waitForDisplayed();
      await (await $('[aria-label="Recent commits"]')).waitForDisplayed();
      const fixtureCommit = await $(
        'aria/Commit 0123456: Accessibility fixture commit'
      );
      await fixtureCommit.waitForClickable();
      await expectAttribute(
        'aria/Commit 0123456: Accessibility fixture commit',
        'aria-pressed',
        'false'
      );
      await fixtureCommit.click();
      await expectAttribute(
        'aria/Commit 0123456: Accessibility fixture commit',
        'aria-pressed',
        'true'
      );
      const commitInput = await $('aria/Optional commit SHA, branch, or tag');
      await commitInput.setValue('  0123456789ABCDEF  ');
      await expectAttribute(
        'aria/Commit 0123456: Accessibility fixture commit',
        'aria-pressed',
        'true'
      );
      await expectAttribute(
        'aria/Commit 0123456: Accessibility fixture commit',
        'class',
        'commit-item selected'
      );
      await branch.selectByVisibleText('accessibility-fixture');
      await browser.waitUntil(
        async () =>
          (await (
            await $('aria/Commit 0123456: Accessibility fixture commit')
          ).getAttribute('aria-pressed')) === 'true',
        {
          timeoutMsg:
            'Commit selection was not restored after the branch list refreshed',
        }
      );
      await expectAttribute(
        'aria/Commit 0123456: Accessibility fixture commit',
        'class',
        'commit-item selected'
      );
      await commitInput.setValue('manual-ref');
      await expectAttribute(
        'aria/Commit 0123456: Accessibility fixture commit',
        'aria-pressed',
        'false'
      );
      await scan('Bleeding Edge channel selection');

      await (await $('aria/Back')).click();
      await stable.waitForClickable();
      await expectFocused('aria/Stable', 'Returned update channel');
      await (await $('aria/Unstable')).click();
      await (await $('aria/Applying Channel')).waitForDisplayed();
      await expectFocused('aria/Applying Channel', 'Applying channel heading');
      return;
    }

    await chooseStableChannel();

    if (state === 'progress') {
      await (await $('aria/Downloading Update')).waitForDisplayed();
      await (await $('aria/Update progress')).waitForDisplayed();
      await expectAttribute('[role="status"]', 'aria-live', 'polite', false);
      await expectAttribute('aria/Update progress', 'value', '27');
      await expectAttribute('aria/Update progress', 'max', '100');
      await expectAttribute(
        'aria/Update progress',
        'aria-valuetext',
        '2.2 MB of 8 MB'
      );
      await expectTextContent(
        '[role="status"]',
        'Downloading Update. 2 MB of 8 MB'
      );
      await scan('Update progress');
      return;
    }

    if (state === 'failure') {
      await (await $('aria/Action required')).waitForDisplayed();
      await expectFocused('aria/Action required', 'Failure alert heading');
      await expectAttribute('[role="alert"]', 'aria-live', 'assertive');
      await scan('Update failure');
      return;
    }

    if (state === 'recovery') {
      await (
        await $('aria/Restoring Previous Installation')
      ).waitForDisplayed();
      await expectFocused(
        'aria/Restoring Previous Installation',
        'Recovery status heading'
      );
      await expectAttribute('[role="status"]', 'aria-live', 'polite', false);
      await scan('Update recovery');
      return;
    }

    throw new Error(`Unhandled updater accessibility state: ${state}`);
  });
});
