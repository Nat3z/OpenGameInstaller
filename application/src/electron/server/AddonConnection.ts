
import wsLib from 'ws';
import { OGIAddonConfiguration, WebsocketMessageClient, WebsocketMessageServer } from "ogi-addon";
import { ConfigurationFile } from 'ogi-addon/lib/ConfigurationBuilder';

export class AddonConnection {
  public addonInfo: OGIAddonConfiguration;
  public ws: wsLib.WebSocket;
  public configTemplate: ConfigurationFile;

  constructor(ws: wsLib.WebSocket) {
    this.ws = ws;
  }

  public async setupWebsocket(): Promise<boolean> {
    return new Promise((resolve, _) => {

      const authenticationTimeout = setTimeout(() => {
        this.ws.close(1008, 'Authentication timeout');
        console.error("Client kicked due to authentication timeout")
        resolve(false)
      }, 1000);

      this.ws.on('message', (message) => {
        const data: WebsocketMessageClient = JSON.parse(message.toString());

        switch (data.event) {
          case 'authenticate':
            clearTimeout(authenticationTimeout);

            // authentication
            this.addonInfo = data.args;
            console.log('Client authenticated:', data.args.name);
            resolve(true);
            break;
          case 'configure':
            if (!this.addonInfo) {
              console.error('Client attempted to send config before authentication');
              this.ws.close(1008, 'Client attempted to send config before authentication');
              return;
            }
            this.configTemplate = data.args;
            break;
        }
      });

    });
  }
  public sendEventMessage(message: WebsocketMessageServer, expectResponse: boolean = true): Promise<WebsocketMessageClient> {
    if (expectResponse) {
      message.id = Math.random().toString(36).substring(7);
    }
    return new Promise((resolve, reject) => {
      this.ws.send(JSON.stringify(message), (err) => {
        if (err) {
          reject(err);
        }
      });
      if (expectResponse) {
        const waitResponse = () => {
          console.log("registered listerner for " + message.id)
          this.ws.once('message', (messageRaw) => {
            const messageFromClient: WebsocketMessageClient = JSON.parse("" + messageRaw.toString())
            if (messageFromClient.event === "response" && messageFromClient.id === message.id) {
              resolve(messageFromClient);
            }
            else {
              waitResponse();
            }
          });
        }
        waitResponse();
      }
      else {
        resolve({ event: 'response', args: 'OK' });
      }
    });
  }
}