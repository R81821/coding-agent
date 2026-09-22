import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HarnessDatabase, VaultCrypto } from '@harness/persistence';
import { HarnessEngine, ProjectTrustService } from '@harness/core';
import { SkillService, MemoryService } from '@harness/extensions';
import { ToolRegistry } from '@harness/tools';
import { descriptor, type ModelProvider } from '@harness/providers';
import { DEFAULT_PROFILE, nowIso, type AgentEvent, type ModelRequest, type RunSpec } from '@harness/protocol';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'skill-session-')); roots.push(root);
  const vault = await VaultCrypto.open(join(root, 'key.json'), 'test-password-skills');
  const dbPath = join(root, 'db.sqlite');
  const database = await HarnessDatabase.open(dbPath, vault);
  const skills = new SkillService(join(root, 'global'));
  const docs = [];
  for (const dir of [join(root, 'global', 'demo'), join(root, '.agent', 'skills', 'demo')]) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), `---\nname: demo\ndescription: shared name\n---\n${dir.includes('global') ? 'GLOBAL_MARKER' : 'PROJECT_MARKER'}`);
    const doc = await skills.load(join(dir, 'SKILL.md'));
    const trusted = await skills.load(doc.manifest.sourcePath, doc.hash);
    database.saveSkill(trusted.manifest); docs.push(trusted);
  }
  const at = nowIso();
  database.createSession({ id: 'one', workspacePath: root, profileId: 'default', title: 'one', createdAt: at, updatedAt: at });
  database.createSession({ id: 'two', workspacePath: root, profileId: 'default', title: 'two', createdAt: at, updatedAt: at, skillSelection: [] });
  return { root, vault, dbPath, database, skills, docs };
}
it('persists independent selections, explicit empty choices and source-qualified trust across database reopen', async () => {
  const f = await fixture();
  f.database.touchSession('one', { skillSelection: f.docs.map(doc => doc.key) });
  f.database.close();
  const reopened = await HarnessDatabase.open(f.dbPath, f.vault);
  try {
    expect(reopened.getSessionDetail('one')?.session.skillSelection).toEqual(f.docs.map(doc => doc.key));
    expect(reopened.getSessionDetail('two')?.session.skillSelection).toEqual([]);
    expect(reopened.listSkills()).toHaveLength(2);
    expect(new Set(reopened.listSkills().map(doc => doc.key)).size).toBe(2);
  } finally { reopened.close(); f.vault.dispose(); }
});

it('freezes selected skills at run start, resumes the original set and applies changed choices only to the next run', async () => {
  const f = await fixture();
  const requests: ModelRequest[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const provider: ModelProvider = {
    id: 'fake', listModels: async () => [descriptor({ providerId: 'fake', modelId: 'fake', displayName: 'fake' })], health: async () => true, estimateCost: () => 0,
    async *stream(request) { requests.push(request); if (requests.length === 1) await gate; yield { type: 'text_delta', delta: 'done' }; }
  };
  const engine = new HarnessEngine({ database: f.database, providers: [provider], tools: new ToolRegistry(), skills: f.skills, memory: new MemoryService(f.database), projectTrust: new ProjectTrustService(f.database) });
  const profile = { ...DEFAULT_PROFILE, allowedProviders: ['fake'], skillIds: [f.docs[0]!.key], toolNames: [] };
  const spec: RunSpec = { id: 'first', sessionId: 'one', request: 'Describe skill', workspacePath: f.root, profileId: 'default', attachments: [], grants: [], budget: DEFAULT_PROFILE.budget, createdAt: nowIso(), workflowVersion: 1 };
  const result = (id: string) => new Promise<Extract<AgentEvent, { type: 'result' }>>(resolve => { const onEvent = (event: AgentEvent) => { if (event.runId === id && event.type === 'result') { engine.off('event', onEvent); resolve(event); } }; engine.on('event', onEvent); });
  const settle = async () => { while (engine.isActive(spec.id)) await new Promise(resolve => setTimeout(resolve, 10)); };
  try {
    const firstResult = result(spec.id); engine.start(spec, profile);
    await new Promise<void>((resolve, reject) => { const deadline = Date.now() + 5000; const timer = setInterval(() => { if (requests.length) { clearInterval(timer); resolve(); } else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('model not called')); } }, 10); });
    f.database.touchSession('one', { skillSelection: [f.docs[1]!.key] });
    expect(engine.pause(spec.id)).toBe(true); release();
    expect((await firstResult).status).toBe('paused'); await settle();
    expect(f.database.getRun(spec.id)?.spec.skills).toEqual([{ key: f.docs[0]!.key, hash: f.docs[0]!.hash }]);
    const resumed = result(spec.id); engine.resume(spec.id, profile); await resumed; await settle();
    expect(f.database.getRun(spec.id)?.spec.skills?.map(ref => ref.key)).toEqual([f.docs[0]!.key]);
    const second = { ...spec, id: 'second' }; const secondResult = result(second.id); engine.start(second, profile); await secondResult;
    while (engine.isActive(second.id)) await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.database.getRun(second.id)?.spec.skills?.map(ref => ref.key)).toEqual([f.docs[1]!.key]);
    const skillText = requests.at(-1)!.messages.flatMap(message => message.content.flatMap(part => part.type === 'text' ? [part.text] : [])).join('\n');
    expect(skillText).toContain('PROJECT_MARKER'); expect(skillText).not.toContain('GLOBAL_MARKER');
  } finally { release(); engine.cancel(spec.id); await settle(); f.database.close(); f.vault.dispose(); }
}, 20000);
