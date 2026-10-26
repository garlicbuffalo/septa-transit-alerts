// Writing a file in place empties it first, so a write cut short (a full disk)
// leaves it half-written, and the collector reads its files back next tick: a
// truncated archive shard would fail every tick after it, until the data was
// fetched again. So each file is written beside its final path and renamed
// over it, which replaces it whole or not at all.
import { rename, rm, writeFile } from 'node:fs/promises';

/**
 * Replace `path` with `data` in one step. On failure the old file is left as
 * it was and the temporary one removed.
 * @param {string} path
 * @param {string | Buffer} data
 */
export async function writeFileAtomic(path, data) {
  const tmp = `${path}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
