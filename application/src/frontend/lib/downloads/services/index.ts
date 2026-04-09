import { RequestService } from '@/frontend/lib/downloads/services/RequestService';
import { DirectService } from '@/frontend/lib/downloads/services/DirectService';
import { TorrentService } from '@/frontend/lib/downloads/services/TorrentService';
import { RealDebridService } from '@/frontend/lib/downloads/services/RealDebridService';
import { AllDebridService } from '@/frontend/lib/downloads/services/AllDebridService';
import { TorboxService } from '@/frontend/lib/downloads/services/TorboxService';
import { PremiumizeService } from '@/frontend/lib/downloads/services/PremiumizeService';
import { EmptyService } from '@/frontend/lib/downloads/services/EmptyService';
import type { BaseService } from '@/frontend/lib/downloads/services/BaseService';

export { BaseService } from '@/frontend/lib/downloads/services/BaseService';
export { RequestService } from '@/frontend/lib/downloads/services/RequestService';
export { DirectService } from '@/frontend/lib/downloads/services/DirectService';
export { TorrentService } from '@/frontend/lib/downloads/services/TorrentService';
export { RealDebridService } from '@/frontend/lib/downloads/services/RealDebridService';
export { AllDebridService } from '@/frontend/lib/downloads/services/AllDebridService';
export { TorboxService } from '@/frontend/lib/downloads/services/TorboxService';
export { PremiumizeService } from '@/frontend/lib/downloads/services/PremiumizeService';
export { EmptyService } from '@/frontend/lib/downloads/services/EmptyService';

/**
 * Array of all available service instances. You can iterate over this list to find the
 * handler for a given downloadType.
 */
export const ALL_SERVICES: BaseService[] = [
  new RequestService(),
  new DirectService(),
  new TorrentService(),
  new RealDebridService(),
  new AllDebridService(),
  new TorboxService(),
  new PremiumizeService(),
  new EmptyService(),
];
