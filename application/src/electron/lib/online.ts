import { net } from 'electron';
import {
  type EffectiveOnlineState,
  getRequestedOnlineState,
  resolveEffectiveOnlineState,
} from '@ogi/online-state';

export { type EffectiveOnlineState, getRequestedOnlineState };

export function getEffectiveOnlineState(
  argv: string[] = process.argv
): EffectiveOnlineState {
  return resolveEffectiveOnlineState(
    getRequestedOnlineState(argv),
    net.isOnline()
  );
}
