import type { OGIAddonEvent } from 'ogi-addon';
import type { HandlerContext } from './types';
import { supportsStorefront } from '../lib';

export const closeProtocolError = (
  { connection }: HandlerContext,
  message: string
): void => {
  console.error(message);
  connection.ws.close(1008, message);
};

export const requireAuthenticated = (
  context: HandlerContext,
  event: string
): boolean => {
  if (context.connection.addonInfo) return true;

  closeProtocolError(
    context,
    `Client attempted to send ${event} before authentication`
  );
  return false;
};

export const requireMessageId = (
  context: HandlerContext,
  event: string,
  id: string | undefined
): id is string => {
  if (id) return true;

  closeProtocolError(context, `Client attempted to send ${event} without an ID`);
  return false;
};

export const getClientsSupporting = (
  { server }: HandlerContext,
  storefront: string,
  event: OGIAddonEvent
) => {
  return Array.from(server.getConnections().values()).filter(
    (client) =>
      supportsStorefront(client.addonInfo?.storefronts, storefront) &&
      client.eventsAvailable.includes(event)
  );
};

