import type { WebsocketMessage } from '@ogi-sdk/connect';
import type { OGIAddonServerSentEvent } from 'ogi-addon';
import type { ServerEventArgs } from '@ogi-sdk/addon-server';

export type OGIClientSDKSentEvent = 'forward';
export type OGIClientSDKSentEventArgs = {
  forward: {
    event: OGIAddonServerSentEvent;
    args: ServerEventArgs[OGIAddonServerSentEvent];
  };
};

export interface WebsocketMessageClientSDKToServer<
  T extends OGIClientSDKSentEvent,
> extends WebsocketMessage {
  event: T;
  args: OGIClientSDKSentEventArgs[T];
}

export type AddonServerToClientSDKEvent = 'forward';
export type AddonServerToClientSDKEventArgs = {
  forward: {
    event: OGIAddonServerSentEvent;
    args: ServerEventArgs[OGIAddonServerSentEvent];
  };
};

export interface WebsocketMessageServerToClientSDK<
  T extends AddonServerToClientSDKEvent,
> extends WebsocketMessage {
  event: T;
  args: AddonServerToClientSDKEventArgs[T];
}
