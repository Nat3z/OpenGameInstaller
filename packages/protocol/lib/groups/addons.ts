import { Schema } from 'effect';
import { call, group } from '../define';

/**
 * Addon calls proxied by core, so a frontend needs one socket instead of a
 * second connection to the addon server. Payloads are the addon SDK's own
 * shapes (`SearchResult`, `StoreData`, `CatalogResponse` in `@ogi-sdk/connect`)
 * and stay `Unknown` until those types get schemas.
 */

export const ConnectedAddon = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  storefronts: Schema.Array(Schema.String),
  /** Addon events it listens for, e.g. `search`, `catalog`, `launch-app`. */
  events: Schema.Array(Schema.String),
});
export type ConnectedAddon = typeof ConnectedAddon.Type;

const Game = {
  addonId: Schema.String,
  appID: Schema.Number,
  storefront: Schema.String,
};

export const AddonsGroup = group('addons', {
  list: call({ params: Schema.Void, result: Schema.Array(ConnectedAddon) }),
  /** Download options one addon offers for a game. */
  search: call({
    params: Schema.Struct(Game),
    result: Schema.Array(Schema.Unknown),
  }),
  /** Store page data, or null when the addon has none. */
  gameDetails: call({
    params: Schema.Struct(Game),
    result: Schema.NullOr(Schema.Unknown),
  }),
  catalog: call({
    params: Schema.Struct({ addonId: Schema.String }),
    result: Schema.Unknown,
  }),
});
