import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export const VOLUME_MARKER = '.tqms-evidence-volume';

export interface StorageHealth {
  ok: boolean;
  reason?: string;
  volumeId?: string;
  freeBytes?: number;
}

export interface StagedFile {
  stagingPath: string;
  sha256: string;
  size: number;
  head: Buffer;
}

export class FileTooLargeError extends Error {}

/**
 * Private evidence storage on the persistent disk. Originals are written to a staging
 * area on the same volume, fsynced, then atomically renamed into an append-only object
 * tree addressed by opaque keys. The volume is never served as a static directory.
 */
export class EvidenceStorage {
  readonly objectsDir: string;
  readonly stagingDir: string;

  constructor(
    readonly root: string,
    private readonly minFreeBytes: number,
  ) {
    this.objectsDir = path.join(root, 'objects');
    this.stagingDir = path.join(root, 'staging');
  }

  /** Creates the volume marker on a freshly attached disk. Refuses to overwrite one. */
  async initVolume(): Promise<string> {
    await fs.mkdir(this.root, { recursive: true });
    const marker = path.join(this.root, VOLUME_MARKER);
    const volumeId = randomUUID();
    const handle = await fs.open(marker, 'wx');
    try {
      await handle.writeFile(JSON.stringify({ volumeId, createdAt: new Date().toISOString() }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.mkdir(this.objectsDir, { recursive: true });
    await fs.mkdir(this.stagingDir, { recursive: true });
    return volumeId;
  }

  async readVolumeId(): Promise<string | null> {
    try {
      const raw = await fs.readFile(path.join(this.root, VOLUME_MARKER), 'utf8');
      const parsed = JSON.parse(raw) as { volumeId?: string };
      return typeof parsed.volumeId === 'string' ? parsed.volumeId : null;
    } catch {
      return null;
    }
  }

  /** Readiness: marker present (disk attached), writable, and not dangerously full. */
  async check(): Promise<StorageHealth> {
    try {
      const st = await fs.stat(this.root);
      if (!st.isDirectory()) return { ok: false, reason: 'Evidence storage root is not a directory' };
    } catch {
      return { ok: false, reason: 'Evidence storage root is absent' };
    }
    const volumeId = await this.readVolumeId();
    if (!volumeId) return { ok: false, reason: 'Evidence volume marker missing — disk not attached or not initialized' };
    const probe = path.join(this.stagingDir, `.probe-${randomUUID()}`);
    try {
      await fs.mkdir(this.stagingDir, { recursive: true });
      await fs.mkdir(this.objectsDir, { recursive: true });
      const handle = await fs.open(probe, 'wx');
      await handle.writeFile('probe');
      await handle.sync();
      await handle.close();
      await fs.unlink(probe);
    } catch (err) {
      return { ok: false, reason: `Evidence storage is not writable (${(err as NodeJS.ErrnoException).code ?? 'error'})`, volumeId };
    }
    const stats = await fs.statfs(this.root);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (freeBytes < this.minFreeBytes) {
      return { ok: false, reason: 'Evidence storage is nearly full', volumeId, freeBytes };
    }
    return { ok: true, volumeId, freeBytes };
  }

  /** Streams bytes to staging while hashing; rejects anything over maxBytes. */
  async stage(stream: Readable, maxBytes: number): Promise<StagedFile> {
    await fs.mkdir(this.stagingDir, { recursive: true });
    const stagingPath = path.join(this.stagingDir, `${randomUUID()}.part`);
    const hash = createHash('sha256');
    let size = 0;
    const headChunks: Buffer[] = [];
    let headLen = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) {
          cb(new FileTooLargeError(`File exceeds ${Math.round(maxBytes / 1024 / 1024)} MB limit`));
          return;
        }
        hash.update(chunk);
        if (headLen < 65536) {
          headChunks.push(chunk);
          headLen += chunk.length;
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(stream, meter, createWriteStream(stagingPath, { flags: 'wx' }));
      const handle = await fs.open(stagingPath, 'r+');
      await handle.sync();
      await handle.close();
    } catch (err) {
      await fs.unlink(stagingPath).catch(() => undefined);
      throw err;
    }
    return { stagingPath, sha256: hash.digest('hex'), size, head: Buffer.concat(headChunks).subarray(0, 65536) };
  }

  async stageBuffer(bytes: Buffer): Promise<StagedFile> {
    const { Readable } = await import('node:stream');
    return this.stage(Readable.from([bytes]), Number.MAX_SAFE_INTEGER);
  }

  objectPath(storageKey: string): string {
    if (!/^[0-9a-f-]{36}$/.test(storageKey)) throw new Error('invalid storage key');
    return path.join(this.objectsDir, storageKey.slice(0, 2), storageKey);
  }

  /** Atomically moves a staged file into the immutable object tree. */
  async finalize(staged: StagedFile): Promise<string> {
    const storageKey = randomUUID();
    const target = this.objectPath(storageKey);
    const dir = path.dirname(target);
    await fs.mkdir(dir, { recursive: true });
    await fs.link(staged.stagingPath, target); // fails if target exists; never overwrites
    await fs.unlink(staged.stagingPath);
    await fs.chmod(target, 0o440);
    const dh = await fs.open(dir, 'r');
    await dh.sync();
    await dh.close();
    return storageKey;
  }

  async discard(staged: StagedFile): Promise<void> {
    await fs.unlink(staged.stagingPath).catch(() => undefined);
  }

  /** Removes a finalized object whose metadata commit failed (never an AVAILABLE record). */
  async removeOrphan(storageKey: string): Promise<void> {
    await fs.unlink(this.objectPath(storageKey)).catch(() => undefined);
  }

  openRead(storageKey: string): Readable {
    return createReadStream(this.objectPath(storageKey));
  }

  async readVerified(storageKey: string, sha256: string): Promise<Buffer> {
    const bytes = await fs.readFile(this.objectPath(storageKey));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha256) throw new Error(`Evidence object ${storageKey} failed hash verification`);
    return bytes;
  }
}
