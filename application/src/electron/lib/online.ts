import { net } from 'electron';
import {
  type EffectiveOnlineState,
  getRequestedOnlineState,
  resolveEffectiveOnlineState,
} from './online-state.mjs';

export { type EffectiveOnlineState, getRequestedOnlineState };

export function getEffectiveOnlineState(
  argv: string[] = process.argv
): EffectiveOnlineState {
  return resolveEffectiveOnlineState(
    getRequestedOnlineState(argv),
    net.isOnline()
  );
}
