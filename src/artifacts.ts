import path from "node:path";

const LOCKFILE_NAMES = new Set([
  "Cargo.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "poetry.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "Podfile.lock",
  "go.sum",
  "gradle.lockfile",
  "packages.lock.json",
  "project.assets.json",
]);

const LOCKFILE_SUFFIXES = [".lock", "-lock.json", ".lock.json", ".lock.yaml"];

export function isLockfilePath(relativePath: string): boolean {
  const fileName = path.posix.basename(relativePath.replaceAll("\\", "/"));
  return LOCKFILE_NAMES.has(fileName) || LOCKFILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}
