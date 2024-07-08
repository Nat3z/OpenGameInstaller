import { server, port } from './addon-server';

server.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
