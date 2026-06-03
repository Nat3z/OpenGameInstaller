import { powerSaveBlocker } from 'electron';

let blockerId: number | null = null;

export function setPowerSaveBlockActive(active: boolean) {
  if (active) {
    if (blockerId === null || !powerSaveBlocker.isStarted(blockerId)) {
      blockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
    return;
  }

  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) {
    powerSaveBlocker.stop(blockerId);
  }
  blockerId = null;
}

export function releasePowerSaveBlock() {
  setPowerSaveBlockActive(false);
}
