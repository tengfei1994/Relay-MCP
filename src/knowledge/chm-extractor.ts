import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

const PINNED_7ZZ_SHA256 = 'd32657a7a0e4cdc0a8aa57cafe474746944d76e861e753e9c902b9c9356fa886';

/** Managed deployments use their verified bundle; an incomplete bundle never silently uses PATH. */
export function resolveChmExtractor(options: { env?: NodeJS.ProcessEnv; cwd?: string; platform?: NodeJS.Platform } = {}): string {
  const env = options.env ?? process.env;
  if (env.RELAY_CHM_EXTRACTOR) return env.RELAY_CHM_EXTRACTOR;
  const platform = options.platform ?? process.platform;
  const home = resolve(env.KNOWLEDGE_ENGINE_HOME ?? join(options.cwd ?? process.cwd(), 'runtime', 'knowledge-engine'));
  const configPath = join(home, 'engine.json');
  if (!existsSync(configPath)) return platform === 'win32' ? 'hh.exe' : '7zz';
  if (lstatSync(home).isSymbolicLink() || lstatSync(configPath).isSymbolicLink()) throw new Error('Managed CHM runtime configuration cannot be a symlink');
  let config: { releasePath?: unknown };
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch { throw new Error('Managed CHM runtime configuration is invalid'); }
  if (typeof config.releasePath !== 'string') throw new Error('Managed CHM runtime release is missing');
  const release = resolve(config.releasePath), releases = join(home, 'releases');
  const local = relative(releases, release);
  if (!local || local.startsWith('..') || isAbsolute(local)) throw new Error('Managed CHM runtime release is outside its home');
  const binary = join(release, 'tools', '7zip', '7zz');
  if (!existsSync(binary)) throw new Error('Managed CHM extractor is missing; install the complete managed engine bundle');
  if (realpathSync(binary) !== binary || !lstatSync(binary).isFile()) throw new Error('Managed CHM extractor cannot be a symlink');
  if (createHash('sha256').update(readFileSync(binary)).digest('hex') !== PINNED_7ZZ_SHA256) throw new Error('Managed CHM extractor checksum mismatch; reinstall the verified bundle');
  return binary;
}

export function chmExtractionArguments(extractor: string, output: string, source: string): string[] {
  return /^7z(?:z|a|zs)?(?:\.exe)?$/i.test(basename(extractor))
    ? ['x', '-y', '-bd', '-bb0', `-o${output}`, source]
    : ['-decompile', output, source];
}