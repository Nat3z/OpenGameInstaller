import { Schema } from 'effect';
import { call, group } from '../define';

/**
 * DRAFT: no server implements this group yet.
 *
 * Addon calls a frontend makes today through client-kit's `Connection`
 * straight to the addon server. Once core proxies them, a frontend needs one
 * socket instead of two. Payloads stay `Unknown` until the addon protocol
 * types in `@ogi-sdk/connect` get schemas.
 */

const Addon = Schema.Struct({ addonId: Schema.String });

export const ConnectedAddon = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  storefronts: Schema.Array(Schema.String),
});

export const AddonsGroup = group('addons', {
  list: call({ params: Schema.Void, result: Schema.Array(ConnectedAddon) }),
  search: call({
    params: Schema.Struct({
      addonId: Schema.String,
      appID: Schema.Number,
      storefront: Schema.String,
    }),
    result: Schema.Array(Schema.Unknown),
  }),
  catalog: call({ params: Addon, result: Schema.Unknown }),
  gameDetails: call({
    params: Schema.Struct({
      addonId: Schema.String,
      appID: Schema.Number,
      storefront: Schema.String,
    }),
    result: Schema.Unknown,
  }),
});
