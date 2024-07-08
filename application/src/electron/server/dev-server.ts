import { server, port } from './addon-server';
import { addonSecret, applicationAddonSecret } from './constants';
console.log("Addon Secret is: " + addonSecret);
console.log("Application Addon Secret is: " + applicationAddonSecret);

server.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
