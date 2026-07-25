<script lang="ts">
type Outcome =
  | 'Passed'
  | 'Failed'
  | 'Flaky'
  | 'Skipped'
  | 'Cancelled'
  | 'Aborted'
  | 'Infrastructure Failed';
type State = {
  runId: string | null;
  status: 'Idle' | 'Running' | Outcome;
  outcome: Outcome | null;
  startedAt: string | null;
  elapsedMilliseconds: number;
  activeStep: { id: string; name: string; startedAt: string } | null;
  scenarios: Array<{
    id: string;
    kind: string;
    outcome: Outcome;
    attempts: number;
    steps: Array<{
      id: string;
      name: string;
      outcome?: 'Passed' | 'Failed';
      error?: string;
    }>;
  }>;
  totals: Record<Outcome, number>;
  retries: number;
  artifacts: Array<{ type: string; path: string; stepId?: string }>;
  latestScreenshot: string | null;
  logs: string[];
  lastSequence: number;
  processActive: boolean;
  canRerun: boolean;
  output: string[];
};

const outcomes: Outcome[] = [
  'Passed',
  'Failed',
  'Flaky',
  'Skipped',
  'Cancelled',
  'Aborted',
  'Infrastructure Failed',
];
let state: State = {
  runId: null,
  status: 'Idle',
  outcome: null,
  startedAt: null,
  elapsedMilliseconds: 0,
  activeStep: null,
  scenarios: [],
  totals: Object.fromEntries(outcomes.map((outcome) => [outcome, 0])) as Record<
    Outcome,
    number
  >,
  retries: 0,
  artifacts: [],
  latestScreenshot: null,
  logs: [],
  lastSequence: 0,
  processActive: false,
  canRerun: false,
  output: [],
};
let suite = 'application-smoke';
let commandError = '';
let connectionStatus = 'Connecting';
let now = Date.now();
let socket: WebSocket;

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.addEventListener('open', () => {
    connectionStatus = 'Live';
  });
  socket.addEventListener('message', (message) => {
    const value = JSON.parse(String(message.data));
    if (value.type === 'snapshot') {
      state = value.state;
      commandError = '';
    } else if (value.type === 'command-error') {
      commandError = value.message;
    }
  });
  socket.addEventListener('close', () => {
    connectionStatus = 'Reconnecting';
    window.setTimeout(connect, 500);
  });
}

function send(command: object) {
  commandError = '';
  socket.send(JSON.stringify(command));
}

function artifactUrl(path: string) {
  return `/artifact?path=${encodeURIComponent(path)}`;
}

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

$: liveElapsed =
  state.processActive && state.startedAt
    ? Math.max(state.elapsedMilliseconds, now - Date.parse(state.startedAt))
    : state.elapsedMilliseconds;

connect();
const timer = window.setInterval(() => (now = Date.now()), 1000);
window.addEventListener('beforeunload', () => window.clearInterval(timer), {
  once: true,
});
</script>

<svelte:head>
  <meta name="description" content="Observe and control OpenGameInstaller end-to-end runs" />
</svelte:head>

<div class="shell">
  <header class="topbar">
    <div>
      <p class="eyebrow">E2E harness</p>
      <h1>Observer Window</h1>
    </div>
    <div class="run-meta" aria-live="polite">
      <span class:live={connectionStatus === 'Live'} class="connection">{connectionStatus}</span>
      <strong>{state.status}</strong>
      <span>{formatDuration(liveElapsed)}</span>
    </div>
    <div class="controls" aria-label="Run controls">
      <label>
        Suite
        <select bind:value={suite} disabled={state.processActive}>
          <option value="application-smoke">Application smoke</option>
        </select>
      </label>
      <button
        class="primary"
        disabled={state.processActive}
        on:click={() => send({ type: 'start', suite })}>Start</button
      >
      <button
        class="danger"
        disabled={!state.processActive}
        on:click={() => send({ type: 'stop' })}>Stop</button
      >
      <button
        disabled={!state.canRerun}
        on:click={() => send({ type: 'rerun-failed' })}>Rerun failed</button
      >
    </div>
  </header>

  {#if commandError}
    <p class="command-error" role="alert">{commandError}</p>
  {/if}

  <main>
    <aside class="panel scenarios" aria-labelledby="scenarios-heading">
      <div class="panel-heading">
        <p class="eyebrow">Run map</p>
        <h2 id="scenarios-heading">Scenarios</h2>
      </div>
      {#if state.scenarios.length === 0}
        <p class="empty">Choose a suite and start a run.</p>
      {:else}
        <ol>
          {#each state.scenarios as scenario}
            <li class="scenario-item">
              <div class="scenario-title">
                <span class="outcome-dot" data-outcome={scenario.outcome}></span>
                <strong>{scenario.kind}</strong>
              </div>
              <code>{scenario.id}</code>
              <span class="scenario-attempts">{scenario.attempts} attempt{scenario.attempts === 1 ? '' : 's'}</span>
              <ol class="steps">
                {#each scenario.steps as step}
                  <li class="step-item" class:active={state.activeStep?.id === step.id}>
                    <span>{step.name}</span>
                    <small>{step.outcome ?? (state.activeStep?.id === step.id ? 'Running' : 'Pending')}</small>
                  </li>
                {/each}
              </ol>
            </li>
          {/each}
        </ol>
      {/if}
    </aside>

    <section class="workspace" aria-labelledby="current-step-heading">
      <div class="panel current-step">
        <p class="eyebrow">Current step</p>
        <h2 id="current-step-heading">{state.activeStep?.name ?? (state.outcome ? 'Run complete' : 'Waiting to start')}</h2>
        <p class="muted">
          {state.runId ? `Run ${state.runId}` : 'No run is active'}
        </p>
      </div>

      <figure class="panel screenshot">
        {#if state.latestScreenshot}
          <img src={artifactUrl(state.latestScreenshot)} alt="Latest screenshot from the active end-to-end run" />
          <figcaption>{state.latestScreenshot}</figcaption>
        {:else}
          <div class="screenshot-empty" role="img" aria-label="No run screenshot is available yet">
            <span class="screenshot-label">Screenshot</span>
            <p>The latest named-step capture will appear here.</p>
          </div>
        {/if}
      </figure>

      <section class="panel timeline" aria-labelledby="timeline-heading">
        <div class="panel-heading inline">
          <div>
            <p class="eyebrow">Validated Run Event Log</p>
            <h2 id="timeline-heading">Timeline</h2>
          </div>
          <span class="panel-meta">{state.lastSequence} events</span>
        </div>
        <ol>
          {#each state.scenarios.flatMap((scenario) => scenario.steps) as step}
            <li class="timeline-item">
              <span class="outcome-dot" data-outcome={step.outcome ?? 'Running'}></span>
              <div>
                <strong>{step.name}</strong>
                {#if step.error}<p>{step.error}</p>{/if}
              </div>
              <span class="timeline-outcome">{step.outcome ?? 'Running'}</span>
            </li>
          {:else}
            <li class="empty">Named steps will appear as the run advances.</li>
          {/each}
        </ol>
      </section>
    </section>

    <aside class="rail" aria-label="Run evidence and statistics">
      <section class="panel" aria-labelledby="outcomes-heading">
        <div class="panel-heading inline">
          <div>
            <p class="eyebrow">Execution</p>
            <h2 id="outcomes-heading">Outcomes</h2>
          </div>
          <span class="panel-meta">{state.retries} retries</span>
        </div>
        <dl class="totals">
          {#each outcomes as outcome}
            <div>
              <dt>{outcome}</dt>
              <dd>{state.totals[outcome]}</dd>
            </div>
          {/each}
        </dl>
      </section>

      <section class="panel" aria-labelledby="artifacts-heading">
        <div class="panel-heading">
          <p class="eyebrow">Retained evidence</p>
          <h2 id="artifacts-heading">Artifacts</h2>
        </div>
        <ul class="artifact-list">
          {#each state.artifacts as artifact}
            <li class="artifact-item"><a href={artifactUrl(artifact.path)} target="_blank" rel="noreferrer">{artifact.type}: {artifact.path}</a></li>
          {:else}
            <li class="empty">No artifacts recorded yet.</li>
          {/each}
        </ul>
      </section>

      <details class="panel logs">
        <summary>Live logs <span class="logs-count">{state.output.length}</span></summary>
        <pre aria-label="Live runner logs">{state.output.join('\n') || 'No log output yet.'}</pre>
        {#if state.logs.length}
          <ul>
            {#each state.logs as path}
              <li><a href={artifactUrl(path)} target="_blank" rel="noreferrer">Open {path}</a></li>
            {/each}
          </ul>
        {/if}
      </details>
    </aside>
  </main>
</div>
