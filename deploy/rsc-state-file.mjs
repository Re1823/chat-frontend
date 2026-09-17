import {chmod, chown, open, readFile, rename, rm, stat} from 'node:fs/promises';
import {dirname} from 'node:path';

export const RSC_STATE_MODE = 0o640;

async function stateGroupId(path) {
  try { return (await stat(path)).gid; }
  catch { return (await stat(dirname(path))).gid; }
}

export async function atomicWriteRootRscState(path, value) {
  const groupId = await stateGroupId(path);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temp, 'wx', RSC_STATE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.chown(0, groupId);
    await handle.chmod(RSC_STATE_MODE);
    await handle.sync();
    await handle.close();
    await rename(temp, path);
    await chown(path, 0, groupId);
    await chmod(path, RSC_STATE_MODE);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return value;
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temp, {force: true}).catch(() => {});
    throw error;
  }
}

export async function repairRootRscStateMetadata(path) {
  const before = await readFile(path);
  const groupId = await stateGroupId(path);
  await chown(path, 0, groupId);
  await chmod(path, RSC_STATE_MODE);
  const after = await readFile(path);
  if (!before.equals(after)) throw new Error('RSC_STATE_CONTENT_CHANGED');
}
