import { z } from 'zod';

export const ProjectConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  defaultEngine: z.enum(['claude', 'opencode']),
  opencodeAttachUrl: z.string().url().nullable().optional(),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const ProjectsConfigSchema = z.array(ProjectConfigSchema);

export type ProjectsConfig = z.infer<typeof ProjectsConfigSchema>;
