import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import {
  executeLiveServiceScenario,
  resolveLiveServiceRequest,
} from './live-service-scenarios';

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function explicitConfirmation() {
  if (process.argv.includes('--confirm-live-service')) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(
      'This Live Service Scenario makes real credentialed external calls. Type RUN LIVE SERVICE to continue: '
    );
    return answer === 'RUN LIVE SERVICE';
  } finally {
    prompt.close();
  }
}

const provider = argument('--provider');
if (!provider) {
  throw new Error('Live Service CLI requires explicit --provider selection');
}
const confirmed = await explicitConfirmation();
const environment = {
  ...process.env,
  ...(process.env.OGI_LIVE_SERVICE_CREDENTIAL
    ? {
        [provider === 'github'
          ? 'OGI_LIVE_GITHUB_TOKEN'
          : 'OGI_LIVE_SYNTHETIC_TOKEN']:
          process.env.OGI_LIVE_SERVICE_CREDENTIAL,
      }
    : {}),
};
const request = resolveLiveServiceRequest({
  provider,
  confirmed,
  environment,
});
if (
  request.provider.id === 'synthetic-local' &&
  process.env.OGI_LIVE_SERVICE_ALLOW_SYNTHETIC !== '1'
) {
  throw new Error(
    'Synthetic local Live Service provider is reserved for automated validation'
  );
}
const endpoint =
  request.provider.id === 'synthetic-local'
    ? (argument('--endpoint') ?? process.env.OGI_LIVE_SERVICE_ENDPOINT)
    : undefined;
if (request.provider.id === 'synthetic-local' && !endpoint) {
  throw new Error('Synthetic local Live Service provider requires --endpoint');
}

const announcementPath = process.env.OGI_OBSERVER_ANNOUNCEMENT;
const executionControl = {
  confirmed: true,
  credential: request.credential,
  cancellationPath: process.env.OGI_OBSERVER_CANCELLATION,
  onStarted: (announcement: {
    runId: string;
    sandboxDirectory: string;
    eventLogPath: string;
  }) => {
    if (announcementPath) {
      writeFileSync(announcementPath, JSON.stringify(announcement));
    }
  },
};
const result =
  request.provider.id === 'synthetic-local'
    ? await executeLiveServiceScenario({
        ...executionControl,
        provider: 'synthetic-local',
        endpoint: endpoint!,
      })
    : await executeLiveServiceScenario({
        ...executionControl,
        provider: 'github',
      });

console.log(
  `Live Service external integration health: ${result.externalIntegrationHealth.provider} ${result.externalIntegrationHealth.status}`
);
console.log(
  'Deterministic coverage: not evaluated by this Live Service Scenario'
);
console.log(`Retained redacted evidence: ${result.sandboxDirectory}`);
process.exitCode = result.outcome === 'Passed' ? 0 : 1;
