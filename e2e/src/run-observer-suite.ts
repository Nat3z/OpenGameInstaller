import { runObserverSuite } from './observer-suite';

const selectionIndex = process.argv.indexOf('--selection');
const selectionId = process.argv[selectionIndex + 1];
if (!selectionId) {
  throw new Error('Observer suite requires --selection <preset-or-check-id>');
}

const result = await runObserverSuite({
  selectionId,
  announcementPath: process.env.OGI_OBSERVER_ANNOUNCEMENT,
  cancellationPath: process.env.OGI_OBSERVER_CANCELLATION,
});
process.exitCode = result.outcome === 'Passed' ? 0 : 1;
