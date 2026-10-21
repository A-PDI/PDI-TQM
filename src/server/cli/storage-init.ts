import { loadConfig } from '../config.js';
import { EvidenceStorage } from '../storage.js';

/**
 * One-time initialization of a freshly attached evidence disk. Writes the volume marker that
 * readiness requires, so an unmounted (ephemeral) path can never be mistaken for the disk.
 */
async function main() {
  const config = loadConfig();
  const storage = new EvidenceStorage(config.storageRoot, config.storageMinFreeBytes);
  const existing = await storage.readVolumeId();
  if (existing) {
    console.log(`Evidence volume already initialized (${existing}); nothing changed.`);
    return;
  }
  const volumeId = await storage.initVolume();
  console.log(`Initialized evidence volume ${volumeId} at ${config.storageRoot}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
