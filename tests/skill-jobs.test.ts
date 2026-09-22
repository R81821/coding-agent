import { expect, it } from 'vitest';
import { SkillJobs } from '../packages/core/src/skill-jobs.js';
import { SkillInstaller, SkillService } from '@harness/extensions';
import { DEFAULT_PROFILE, type ModelRequest } from '@harness/protocol';
import { descriptor, ParallelSearchProvider, type ModelProvider } from '@harness/providers';

async function finished(jobs: SkillJobs, id: string) {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(timer); reject(new Error('job timeout')); }, 3000);
    const timer = setInterval(() => { if (jobs.get(id).status !== 'running') { clearInterval(timer); clearTimeout(timeout); resolve(); } }, 10);
  });
  return jobs.get(id);
}
it('reports preview network errors and allows another independent retry', async () => {
  let fail = true;
  const installer = new SkillInstaller(new SkillService('/unused'), async () => { if (fail) throw new Error('network offline'); return new Response('', { status: 429 }); });
  const jobs = new SkillJobs(installer, [], () => {});
  const first = await finished(jobs, jobs.preview('npx skills add owner/repo -g').id);
  expect(first).toMatchObject({ status: 'failed', error: 'network offline' });
  fail = false;
  expect((await finished(jobs, jobs.preview('npx skills add owner/repo -g').id)).error).toMatch(/429/);
});
it('cancels in-flight requests without reporting success', async () => {
  const installer = new SkillInstaller(new SkillService('/unused'), async (_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
  const jobs = new SkillJobs(installer, [], () => {});
  const job = jobs.preview('npx skills add owner/repo -g');
  jobs.cancel(job.id);
  expect((await finished(jobs, job.id)).status).toBe('cancelled');
});
it.each([false, true])('uses read-only GitHub fallback when search is missing or misconfigured (%s)', async invalidSearch => {
  const requests: ModelRequest[] = []; let fallbackUsed = false;
  const provider: ModelProvider = {
    id: 'openai', listModels: async () => [descriptor({ providerId: 'openai', modelId: 'test', displayName: 'test' })], health: async () => true, estimateCost: () => 0,
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) yield { type: 'tool_call', toolCall: { id: 'search', name: 'search_skills', input: { query: 'pdf' } } } as const;
      else if (requests.length === 2) yield { type: 'tool_call', toolCall: { id: 'submit', name: 'submit_recommendations', input: { recommendations: [{ name: 'made up', purpose: 'PDF', reason: 'fit', source: 'https://github.com/missing/repo', command: 'npx skills add missing/repo -g' }] } } } as const;
      else yield { type: 'text_delta', delta: 'No verified results.' } as const;
    }
  };
  const installer = new SkillInstaller(new SkillService('/unused'), async input => { if (String(input).includes('/search/repositories')) { fallbackUsed = true; return Response.json({ items: [] }); } return new Response('', { status: 404 }); });
  const jobs = new SkillJobs(installer, [provider], () => {}, invalidSearch ? new ParallelSearchProvider('x'.repeat(17) + '选填') : undefined);
  const result = await finished(jobs, jobs.recommend('pdf skills', DEFAULT_PROFILE).id);
  expect(fallbackUsed).toBe(true);
  if (invalidSearch) expect(result.text).toMatch(/PARALLEL_API_KEY/);
  expect(requests[0]?.tools.map(tool => tool.name).sort()).toEqual(['inspect_skill', 'search_skills', 'submit_recommendations']);
  // Unreachable source: the candidate is kept and labelled, not dropped while the user sees nothing.
  expect(result.recommendations?.[0]?.verified).toBe(false);
  expect(result.recommendations?.[0]?.diagnostic).toMatch(/404/);
  expect(result.recommendations?.[0]?.reason).toMatch(/未验证/);
  // Installing is still gated: filling the download panel runs a preview, which is where the real
  // existence check happens. The command string alone never installs anything.
  expect(result.recommendations?.[0]?.command).toBe('npx skills add missing/repo -g');
});

it('verifies reachable sources and lists them before unverified candidates', async () => {
  const provider: ModelProvider = {
    id: 'openai', listModels: async () => [descriptor({ providerId: 'openai', modelId: 'test', displayName: 'test' })], health: async () => true, estimateCost: () => 0,
    async *stream(request) {
      if (request.messages.every(message => message.content.every(part => part.type !== 'tool_result')))
        yield { type: 'tool_call', toolCall: { id: 'submit', name: 'submit_recommendations', input: { recommendations: [
          // Deliberately submitted worst-first: the job must order them, not the model.
          { name: 'zulu candidate', purpose: 'p', reason: 'r', source: 'https://github.com/missing/one', command: 'npx skills add missing/one -g' },
          { name: 'alpha verified', purpose: 'p', reason: 'r', source: 'https://github.com/acme/alpha', command: 'npx skills add acme/alpha -g' },
        ] } } } as const;
      else yield { type: 'text_delta', delta: 'done' } as const;
    }
  };
  // Mirrors the real preview sequence: HEAD commit -> full tree -> raw download.
  // Only acme/alpha exists; missing/one must 404 on every probe, which is what keeps it unverified.
  const installer = new SkillInstaller(new SkillService('/unused'), async input => {
    const url = String(input);
    if (!url.includes('acme/alpha')) return new Response('', { status: 404 });
    if (url.includes('/commits/HEAD')) return Response.json({ sha: 'a'.repeat(40) });
    // The installer verifies the git blob hash (sha1 of "blob <len>\0<content>"), not a plain sha1.
    if (url.includes('/git/trees/')) return Response.json({ tree: [{ path: 'SKILL.md', type: 'blob', mode: '100644', sha: '51c03521ef42eb78d19e20958e89258d1d5304ea', size: 64 }] });
    if (url.startsWith('https://raw.githubusercontent.com/')) return new Response('---\nname: Alpha Skill\ndescription: verified\n---\nbody');
    return new Response('', { status: 404 });
  });
  const jobs = new SkillJobs(installer, [provider], () => {});
  const result = await finished(jobs, jobs.recommend('anything', DEFAULT_PROFILE).id);
  const cards = result.recommendations ?? [];
  expect(cards.map(card => card.verified)).toEqual([true, false]);
  expect(cards[0]?.name).toBe('Alpha Skill');
  expect(cards[0]?.source).toContain('acme/alpha/tree/');
  const rank = (name: string) => Number(cards.find(card => card.name === name)?.verified === true);
  expect(cards.map(card => card.name)).toEqual([...cards.map(card => card.name)].sort((left, right) => rank(right) - rank(left) || left.localeCompare(right)));
});
