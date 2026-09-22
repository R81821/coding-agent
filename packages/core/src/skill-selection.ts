import type { SkillReference } from "@harness/protocol";
import type { SkillDocument } from "@harness/extensions";

/** Frozen run references take precedence over subsequent conversation choices. */
export function resolveSelectedSkills(selection: string[], documents: SkillDocument[], frozen?: SkillReference[]): SkillDocument[] {
  return [...new Set(frozen ? frozen.map(ref => ref.key) : selection)].map(key => {
    const matches = documents.filter(doc => doc.key === key || (!frozen && doc.manifest.id === key));
    if (matches.length !== 1) throw new Error(`技能缺失或来源不明确（${key}），请重新选择技能`);
    const doc = matches[0]!;
    if (!doc.manifest.enabled) throw new Error(`技能「${doc.manifest.name}」未启用或内容变化，请在技能页重新确认信任`);
    const reference = frozen?.find(ref => ref.key === key);
    if (reference && reference.hash !== doc.hash) throw new Error(`技能「${doc.manifest.name}」内容已变化，不能恢复原运行；请重新选择并开始新运行`);
    return doc;
  });
}
