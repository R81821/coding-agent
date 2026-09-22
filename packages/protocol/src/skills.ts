import { z } from "zod";

export const SkillReferenceSchema = z.object({ key: z.string().min(1), hash: z.string().min(1) });
export type SkillReference = z.infer<typeof SkillReferenceSchema>;
export interface SkillPreviewItem {
  path: string; name: string; description: string; content: string; files: string[];
  installationPath: string; installedRevision?: string;
}
export interface SkillPreview {
  id: string; source: string; revision: string; globalPath: string; skills: SkillPreviewItem[];
}
export interface SkillRecommendation {
  name: string; purpose: string; reason: string; source: string; command?: string; diagnostic?: string;
  /** True only when the source repository was read back and its SKILL.md confirmed. */
  verified?: boolean;
}
export interface SkillJob {
  id: string; kind: "recommend" | "preview" | "install";
  status: "running" | "completed" | "failed" | "cancelled";
  progress: string; text: string; error?: string;
  recommendations?: SkillRecommendation[]; preview?: SkillPreview;
}
