import { server, port } from '@/electron/server/addon-server.js';
import {
  addonSecret,
  applicationAddonSecret,
} from '@/electron/server/constants.js';
console.log('Addon Secret is: ' + addonSecret);
console.log('Application Addon Secret is: ' + applicationAddonSecret);

server.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
