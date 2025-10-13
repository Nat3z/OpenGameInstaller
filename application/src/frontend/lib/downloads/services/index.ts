import { RequestService } from './RequestService';
import { DirectService } from './DirectService';
import { TorrentService } from './TorrentService';
import { RealDebridService } from './RealDebridService';
import { TorboxService } from './TorboxService';
import { PremiumizeService } from './PremiumizeService';
import { EmptyService } from './EmptyService';

export { BaseService } from './BaseService';
export { RequestService } from './RequestService';
export { DirectService } from './DirectService';
export { TorrentService } from './TorrentService';
export { RealDebridService } from './RealDebridService';
export { TorboxService } from './TorboxService';
export { PremiumizeService } from './PremiumizeService';
export { EmptyService } from './EmptyService';

/**
 * Array of all available service instances. You can iterate over this list to find the
 * handler for a given downloadType.
 */
export const ALL_SERVICES = [
  new RequestService(),
  new DirectService(),
  new TorrentService(),
  new RealDebridService(),
  new TorboxService(),
  new PremiumizeService(),
  new EmptyService(),
];
