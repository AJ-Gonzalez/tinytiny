/**
 * Repo root: the directory containing this package (two levels up from
 * src/tools/). Stable regardless of process.cwd() — that's what makes bash's
 * cwd predictable. Own module to avoid an import cycle (bash and index both
 * need it).
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
