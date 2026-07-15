import { AllDebridService } from '@/frontend/lib/downloads/services/AllDebridService';
import type { BaseService } from '@/frontend/lib/downloads/services/BaseService';
import { DirectService } from '@/frontend/lib/downloads/services/DirectService';
import { EmptyService } from '@/frontend/lib/downloads/services/EmptyService';
import { PremiumizeService } from '@/frontend/lib/downloads/services/PremiumizeService';
import { RealDebridService } from '@/frontend/lib/downloads/services/RealDebridService';
import { RequestService } from '@/frontend/lib/downloads/services/RequestService';
import { TorboxService } from '@/frontend/lib/downloads/services/TorboxService';
import { TorrentService } from '@/frontend/lib/downloads/services/TorrentService';

export { AllDebridService } from '@/frontend/lib/downloads/services/AllDebridService';
export { BaseService } from '@/frontend/lib/downloads/services/BaseService';
export { DirectService } from '@/frontend/lib/downloads/services/DirectService';
export { EmptyService } from '@/frontend/lib/downloads/services/EmptyService';
export { PremiumizeService } from '@/frontend/lib/downloads/services/PremiumizeService';
export { RealDebridService } from '@/frontend/lib/downloads/services/RealDebridService';
export { RequestService } from '@/frontend/lib/downloads/services/RequestService';
export { TorboxService } from '@/frontend/lib/downloads/services/TorboxService';
export { TorrentService } from '@/frontend/lib/downloads/services/TorrentService';

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
