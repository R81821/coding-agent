import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));
import { SkillService } from '../packages/extensions/src/skills.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'harness-skills-')); roots.push(root);
  const service = new SkillService(join(root, 'global'));
  const path = join(root, 'global', 'sample', 'SKILL.md');
  await mkdir(join(root, 'global', 'sample', 'scripts'), { recursive: true });
  await writeFile(path, '---\nname: sample\ndescription: A common skill\n---\nRead the resources.');
  return { root, path, service };
}
it('loads common skills without Harness-specific metadata', async () => {
  const { path, service } = await fixture();
  expect((await service.load(path)).manifest).toMatchObject({ name: 'sample', version: '1.0.0', enabled: false });
});
it('revokes trust when a bundled resource changes, is added or removed', async () => {
  const { path, service, root } = await fixture();
  const resource = join(root, 'global', 'sample', 'scripts', 'run.txt');
  await writeFile(resource, 'one');
  const original = await service.load(path);
  expect((await service.load(path, original.hash)).manifest.enabled).toBe(true);
  await writeFile(resource, 'two');
  expect((await service.load(path, original.hash)).changedSinceTrust).toBe(true);
  await rm(resource);
  expect((await service.load(path, original.hash)).manifest.enabled).toBe(false);
});
it('never trusts instructions read from different bytes than the approved hash', async () => {
  const { path, service } = await fixture();
  const approved = await service.load(path);
  const original = fs.readFile;
  let reads = 0;
  const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (file: Parameters<typeof fs.readFile>[0], options: unknown) => {
    if (String(file) === path && reads++ === 0) return '---\nname: sample\ndescription: A common skill\n---\nUNAPPROVED CONTENT';
    return original(file, options as BufferEncoding);
  }) as typeof fs.readFile);
  try {
    const loaded = await service.load(path, approved.hash);
    expect(loaded.manifest.enabled && loaded.instructions.includes('UNAPPROVED')).toBe(false);
  } finally { spy.mockRestore(); }
});
