import { expect, it } from 'vitest';
import { resolveSelectedSkills } from '../packages/core/src/skill-selection.js';
import { SessionRecordSchema, RunSpecSchema, DEFAULT_PROFILE } from '@harness/protocol';
import type { SkillDocument } from '../packages/extensions/src/skills.js';
const global = { key: 'global:one', hash: 'hash1', manifest: { id: 'same', enabled: true, name: 'Same' } } as SkillDocument;
const project = { key: 'project:one', hash: 'hash2', manifest: { id: 'same', enabled: true, name: 'Same' } } as SkillDocument;
it('keeps explicit empty selection distinct from inherited defaults', () => {
  expect(resolveSelectedSkills([], [global], undefined)).toEqual([]);
  expect(resolveSelectedSkills(['same'], [global], undefined)).toEqual([global]);
});
it('distinguishes same-name skills by source and rejects ambiguous legacy defaults', () => {
  expect(resolveSelectedSkills(['project:one'], [global, project], undefined)).toEqual([project]);
  expect(() => resolveSelectedSkills(['same'], [global, project], undefined)).toThrow(/重新选择/);
});
it('refuses missing, revoked and changed skills, including resume after a new version was trusted', () => {
  expect(() => resolveSelectedSkills(['missing'], [global], undefined)).toThrow(/重新选择/);
  expect(() => resolveSelectedSkills([global.key], [{ ...global, manifest: { ...global.manifest, enabled: false } }], undefined)).toThrow(/确认/);
  expect(() => resolveSelectedSkills([], [global], [{ key: global.key, hash: 'old' }])).toThrow(/变化/);
  expect(resolveSelectedSkills([project.key], [global, project], [{ key: global.key, hash: global.hash }])).toEqual([global]);
});
it('preserves session selections and frozen run versions through protocol parsing', () => {
  const at = new Date().toISOString();
  expect(SessionRecordSchema.parse({ id: 's', workspacePath: '/repo', profileId: 'default', title: 's', createdAt: at, updatedAt: at, skillSelection: [] }).skillSelection).toEqual([]);
  expect(RunSpecSchema.parse({ id: 'r', sessionId: 's', workspacePath: '/repo', profileId: 'default', request: 'test', createdAt: at, budget: DEFAULT_PROFILE.budget, skills: [{ key: 'global:one', hash: 'hash1' }] }).skills).toEqual([{ key: 'global:one', hash: 'hash1' }]);
});
