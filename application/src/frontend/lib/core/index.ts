import * as library from '@/frontend/lib/core/library';
import * as ipc from '@/frontend/lib/core/ipc';
import * as fs from '@/frontend/lib/core/fs';
import * as tryCatch from '@/frontend/lib/core/tryCatch';

export default {
  library,
  ipc,
  fs,
  tryCatch: tryCatch.tryCatch,
};
