import { AddonError } from '@ogi-sdk/errors';
import { AddonsGroup, type ConnectedAddon } from '@ogi-sdk/protocol';
import { Context, Effect } from 'effect';
import { type Implementation, implement } from '../server/router';

/**
 * Adapter: the running addons. The Electron host backs it with its
 * in-process addon server; core never opens a socket to itself.
 */
export type AddonsShape = {
  readonly list: Effect.Effect<ConnectedAddon[]>;
  /**
   * Sends one addon event and returns its reply. `event` is the addon
   * protocol name (`search`, `game-details`, `catalog`).
   */
  readonly call: (
    addonId: string,
    event: 'search' | 'game-details' | 'catalog',
    args: unknown
  ) => Effect.Effect<unknown, AddonError>;
};

export class Addons extends Context.Tag('@ogi-sdk/core/Addons')<
  Addons,
  AddonsShape
>() {}

/** Fails clearly instead of hanging when the addon can't handle an event. */
const requireEvent = (addonId: string, event: string) =>
  Effect.flatMap(Addons, (addons) => addons.list).pipe(
    Effect.flatMap((list) => {
      const addon = list.find((candidate) => candidate.id === addonId);
      if (!addon)
        return Effect.fail(
          new AddonError({ message: `Addon ${addonId} is not running` })
        );
      if (!addon.events.includes(event))
        return Effect.fail(
          new AddonError({
            message: `Addon ${addon.name} does not support ${event}`,
            addonName: addon.name,
          })
        );
      return Effect.void;
    })
  );

const forward = (
  addonId: string,
  event: 'search' | 'game-details' | 'catalog',
  args: unknown
) =>
  requireEvent(addonId, event).pipe(
    Effect.andThen(
      Effect.flatMap(Addons, (addons) => addons.call(addonId, event, args))
    )
  );

export const AddonsHandlers: Implementation<Addons> = implement<
  typeof AddonsGroup,
  Addons
>(AddonsGroup, {
  list: () => Effect.flatMap(Addons, (addons) => addons.list),
  search: ({ addonId, appID, storefront }) =>
    forward(addonId, 'search', { appID, storefront, for: 'game' }).pipe(
      Effect.map((results) => (Array.isArray(results) ? results : []))
    ),
  gameDetails: ({ addonId, appID, storefront }) =>
    forward(addonId, 'game-details', { appID, storefront }).pipe(
      Effect.map((details) => details ?? null)
    ),
  catalog: ({ addonId }) => forward(addonId, 'catalog', undefined),
});
