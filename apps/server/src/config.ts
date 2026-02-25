import { z } from 'zod';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectsConfigSchema } from '@ohmyremote/core';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, '..', '..', '..');
dotenv.config({ path: path.join(repoRoot, '.env') });
dotenv.config();

const numericString = (name: string) =>
  z
    .string()
    .regex(/^\d+$/, `${name} must be numeric`);

const optionalBooleanString = (name: string) =>
  z.string().optional().refine((value) => value === undefined || value === 'true' || value === 'false', {
    message: `${name} must be "true" or "false"`,
  }).transform((value) => value === undefined ? undefined : value === 'true');

const optionalPositiveIntegerString = (name: string) =>
  z
    .string()
    .regex(/^\d+$/, `${name} must be a positive integer`)
    .transform((value) => Number(value))
    .refine((value) => Number.isSafeInteger(value) && value > 0, `${name} must be a positive integer`)
    .optional();

export const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_OWNER_USER_ID: numericString('TELEGRAM_OWNER_USER_ID').transform((value) => Number(value)),
  DATA_DIR: z.string().default('./data'),
  PROJECTS_CONFIG_PATH: z.string().default('./config/projects.json'),
  DASHBOARD_BIND_HOST: z.string().default('127.0.0.1'),
  DASHBOARD_PORT: numericString('DASHBOARD_PORT').transform((value) => Number(value)).default(4312),
  MAX_UPLOAD_BYTES: numericString('MAX_UPLOAD_BYTES').transform((value) => Number(value)).default(26214400),
  DASHBOARD_BASIC_AUTH_USER: z.string().optional(),
  DASHBOARD_BASIC_AUTH_PASS: z.string().optional(),
  KILL_SWITCH_DISABLE_RUNS: optionalBooleanString('KILL_SWITCH_DISABLE_RUNS'),
  UNSAFE_MODE_DEFAULT_TTL_MINUTES: optionalPositiveIntegerString('UNSAFE_MODE_DEFAULT_TTL_MINUTES'),
});

export const ProjectsFileSchema = ProjectsConfigSchema;

export type Config = z.infer<typeof EnvSchema> & {
  projects: z.infer<typeof ProjectsFileSchema>;
};

export function loadConfig(overrides: Record<string, string | undefined> = {}): Config {
  const envResult = EnvSchema.safeParse({ ...process.env, ...overrides });
  if (!envResult.success) {
    throw new Error(`Invalid environment variables: ${z.prettifyError(envResult.error)}`);
  }

  const env = envResult.data;

  const projectsPath = path.resolve(env.PROJECTS_CONFIG_PATH);
  if (!fs.existsSync(projectsPath)) {
    throw new Error(
      `Projects config file not found at ${projectsPath}. Create one from config/projects.example.json and set PROJECTS_CONFIG_PATH if needed.`,
    );
  }

  let projects: unknown;
  try {
    const content = fs.readFileSync(projectsPath, 'utf-8');
    projects = JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to read projects config at ${projectsPath}: ${String(err)}`);
  }

  const projectsResult = ProjectsFileSchema.safeParse(projects);
  if (!projectsResult.success) {
    throw new Error(`Invalid projects config at ${projectsPath}: ${z.prettifyError(projectsResult.error)}`);
  }

  return {
    ...env,
    projects: projectsResult.data,
  };
}
