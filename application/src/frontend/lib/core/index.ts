import * as library from './library';
import * as ipc from './ipc';
import * as fs from './fs';
import * as tryCatch from './tryCatch';

export default {
  library,
  ipc,
  fs,
  tryCatch: tryCatch.tryCatch,
};
