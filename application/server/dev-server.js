const { server, port } = require('./addon-server');

server.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
