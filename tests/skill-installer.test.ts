import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));
import * as installerModule from '../packages/extensions/src/skill-installer.js';
import { SkillService } from '../packages/extensions/src/skills.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it.each(['owner/repo', 'https://github.com/owner/repo.git', 'https://github.com/owner/repo/tree/main/skills/demo'])('parses GitHub source %s without executing it', source => {
  expect(installerModule.parseSkillCommand(`npx skills add ${source} --skill demo -g`)).toMatchObject({ owner: 'owner', repo: 'repo', skill: 'demo' });
});
it.each(['npx skills add owner/repo && calc', 'npx skills add owner/repo --yes', 'npx skills add https://evil.test/a/b', 'npx skills add owner/repo;calc', 'npx skills add owner/repo --skill ../x', 'npx skills add owner/repo --skill a --skill b'])('rejects unsupported or chained command %s', command => {
  expect(() => installerModule.parseSkillCommand(command)).toThrow();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'skill-install-')); roots.push(root);
  const service = new SkillService(join(root, 'skills'));
  let revision = 'a'.repeat(40);
  const files: Record<string, string> = { 'skills/demo/SKILL.md': '---\nname: demo\ndescription: Example\n---\nUse scripts/data.txt', 'skills/demo/scripts/data.txt': 'resource one' };
  const modes: Record<string, string> = {};
  let rawUnavailable = false;
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    if (url.includes('/commits/')) return Response.json({ sha: revision });
    if (url.includes('/git/trees/')) return Response.json({ truncated: false, tree: Object.entries(files).map(([path, text]) => ({ path, type: 'blob', mode: modes[path] ?? '100644', size: Buffer.byteLength(text), sha: createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex') })) });
    if (url.includes('/git/blobs/')) {
      const sha = url.split('/').at(-1)!;
      const content = Object.values(files).find(value => createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex') === sha);
      return content === undefined ? new Response('', { status: 404 }) : Response.json({ sha, size: Buffer.byteLength(content), encoding: 'base64', content: Buffer.from(content).toString('base64') });
    }
    if (url.includes('raw.githubusercontent.com')) {
      if (rawUnavailable) throw new TypeError('fetch failed', { cause: Object.assign(new Error('DNS failure'), { code: 'ENOTFOUND' }) });
      const path = url.split('/').slice(6).map(decodeURIComponent).join('/');
      return files[path] === undefined ? new Response('', { status: 404 }) : new Response(files[path]);
    }
    return new Response('', { status: 404 });
  };
  return { root, service, files, modes, installer: new installerModule.SkillInstaller(service, fetcher), setRevision: (value: string) => { revision = value; }, disableRaw: () => { rawUnavailable = true; } };
}
it('previews a pinned version and installs original content with every resource; refuses duplicate trust', async () => {
  const f = await fixture();
  const p = await f.installer.preview('npx skills add owner/repo --skill demo -g');
  expect(p.revision).toBe('a'.repeat(40));
  expect(p.skills[0]?.files.slice().sort()).toEqual(['SKILL.md', 'scripts/data.txt']);
  f.setRevision('b'.repeat(40));
  const installed = await f.installer.install(p.id, 'skills/demo', false);
  expect(installed.manifest.enabled).toBe(true);
  expect(await readFile(installed.manifest.sourcePath, 'utf8')).toBe(f.files['skills/demo/SKILL.md']);
  expect(await readFile(join(installed.manifest.sourcePath, '..', 'scripts', 'data.txt'), 'utf8')).toBe('resource one');
  await expect(f.installer.install(p.id, 'skills/demo', false)).rejects.toThrow(/已安装/);
});
it('requires explicit replacement, and failed replacement preserves installed bytes', async () => {
  const f = await fixture();
  const p = await f.installer.preview('npx skills add owner/repo -g');
  const installed = await f.installer.install(p.id, 'skills/demo', false);
  f.setRevision('b'.repeat(40)); f.files['skills/demo/scripts/data.txt'] = 'resource two';
  const next = await f.installer.preview('npx skills add owner/repo -g');
  expect(next.skills[0]?.installedRevision).toBe('a'.repeat(40));
  await expect(f.installer.install(next.id, 'skills/demo', false)).rejects.toThrow(/替换/);
  await expect(f.installer.install(next.id, 'skills/demo', true, undefined, undefined, () => { throw new Error('database failed'); })).rejects.toThrow('database failed');
  expect(await readFile(join(installed.manifest.sourcePath, '..', 'scripts/data.txt'), 'utf8')).toBe('resource one');
  expect((await readdir(join(f.root, 'skills'))).length).toBe(1);
});
it('cancellation leaves no installation and forged resource bytes fail validation', async () => {
  const f = await fixture(); const p = await f.installer.preview('npx skills add owner/repo -g');
  await expect(f.installer.install(p.id, 'skills/demo', false, AbortSignal.abort())).rejects.toThrow();
  f.files['skills/demo/scripts/data.txt'] = 'tampered';
  await expect(f.installer.install(p.id, 'skills/demo', false)).rejects.toThrow(/校验/);
  expect(await f.service.discover()).toEqual([]);
});
it('preserves the old backup and reports its path when replacement rollback itself fails', async () => {
  const f = await fixture();
  const p = await f.installer.preview('npx skills add owner/repo -g');
  await f.installer.install(p.id, 'skills/demo', false);
  f.setRevision('b'.repeat(40));
  const next = await f.installer.preview('npx skills add owner/repo -g');
  const rename = fs.rename;
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { if (String(from).endsWith('-backup')) throw new Error('restore blocked'); return rename(from, to); });
  try {
    await expect(f.installer.install(next.id, 'skills/demo', true, undefined, undefined, () => { throw new Error('database failed'); })).rejects.toThrow(/备份.*backup/);
    const backups = (await readdir(join(f.root, '.skill-staging'))).filter(name => name.endsWith('-backup'));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(f.root, '.skill-staging', backups[0]!, 'content', 'scripts/data.txt'), 'utf8')).toBe('resource one');
  } finally { spy.mockRestore(); }
});
it('does not let unrelated malformed skills or unsafe resources block an explicitly selected skill', async () => {
  const f = await fixture();
  f.files['skills/bad/SKILL.md'] = '---\nname: bad\ndescription: Unrelated\n---\nUnused';
  f.files['skills/bad/link'] = '/outside'; f.modes['skills/bad/link'] = '120000';
  f.files['skills/malformed/SKILL.md'] = '---\nname: [broken\n---\nUnused';
  const result = await f.installer.preview('npx skills add owner/repo --skill demo -g');
  expect(result.skills.map(skill => skill.name)).toEqual(['demo']);
});
it('uses pinned GitHub blobs when the raw content domain is unavailable', async () => {
  const f = await fixture(); f.disableRaw();
  const p = await f.installer.preview('npx skills add owner/repo --skill demo -g');
  const installed = await f.installer.install(p.id, 'skills/demo', false);
  expect(installed.manifest.enabled).toBe(true);
  expect(await readFile(join(installed.manifest.sourcePath, '..', 'scripts/data.txt'), 'utf8')).toBe('resource one');
});

it('sends a configured GitHub token and reports the quota reset on rate limiting', async () => {
  const seen: Array<Record<string, string>> = [];
  const service = new SkillService(join(await mkdtemp(join(tmpdir(), 'skill-token-')), 'skills'));
  const authorized = new installerModule.SkillInstaller(service, async (_input, init) => {
    seen.push((init?.headers ?? {}) as Record<string, string>);
    return Response.json({ items: [] });
  }, 'ghp_example');
  await authorized.search('pdf');
  expect(seen[0]?.Authorization).toBe('Bearer ghp_example');

  const anonymous = new installerModule.SkillInstaller(service, async (_input, init) => {
    seen.push((init?.headers ?? {}) as Record<string, string>);
    return new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(1_800_000_000) } });
  });
  // No token: the error must say how to raise the quota, not just that it failed.
  const limited = await anonymous.search('pdf').catch(error => (error as Error).message);
  expect(seen[1]?.Authorization).toBeUndefined();
  expect(limited).toMatch(/访问限流/);
  expect(limited).toMatch(/GitHub Token/);
  expect(limited).toMatch(/重置/);
});
