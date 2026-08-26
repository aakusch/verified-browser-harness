import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { HarnessError } from "../errors.mjs";
import { fingerprint } from "../runtime/cache.mjs";

const INCLUDED_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".go",
  ".h",
  ".hpp",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

async function collectFiles(root, directory, output) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        await collectFiles(root, absolutePath, output);
      }
      continue;
    }
    if (!entry.isFile() || !INCLUDED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }
    output.push({ root, absolutePath, relativePath: path.relative(root.path, absolutePath) });
  }
}

export function sourceIndexKey(sourceRoots) {
  return fingerprint(sourceRoots.map((root) => ({ name: root.name, path: root.path })));
}

export async function buildSourceIndex(
  sourceRoots,
  { maxFileBytes = 512_000, maxFiles = 20_000 } = {},
) {
  const files = [];
  for (const root of sourceRoots) {
    let stats;
    try {
      stats = await lstat(root.path);
    } catch (error) {
      throw new HarnessError(`Source root does not exist: ${root.path}`, {
        code: "SOURCE_ROOT_MISSING",
        cause: error,
      });
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new HarnessError(`Source root must be a real directory: ${root.path}`, {
        code: "INVALID_SOURCE_ROOT",
      });
    }
    await collectFiles(root, root.path, files);
    if (files.length > maxFiles) {
      throw new HarnessError(`Source index exceeded ${maxFiles} files`, {
        code: "SOURCE_INDEX_TOO_LARGE",
      });
    }
  }

  const documents = [];
  for (const file of files) {
    const stats = await lstat(file.absolutePath);
    if (stats.size > maxFileBytes) continue;
    const content = await readFile(file.absolutePath, "utf8");
    if (content.includes("\u0000")) continue;
    documents.push({
      repository: file.root.name,
      path: file.relativePath,
      content,
    });
  }

  return {
    schemaVersion: 1,
    key: sourceIndexKey(sourceRoots),
    createdAt: new Date().toISOString(),
    roots: sourceRoots.map((root) => ({ name: root.name, path: root.path })),
    documents,
  };
}

function tokens(value) {
  return [...new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_$.-]+/)
      .filter((token) => token.length >= 2),
  )];
}

function occurrences(haystack, needle) {
  let count = 0;
  let cursor = 0;
  while ((cursor = haystack.indexOf(needle, cursor)) !== -1) {
    count += 1;
    cursor += needle.length;
    if (count >= 12) break;
  }
  return count;
}

function scoreDocument(document, queryTokens) {
  const filePath = document.path.toLowerCase();
  const content = document.content.toLowerCase();
  return queryTokens.reduce((score, token) => {
    const pathScore = filePath.includes(token) ? 12 : 0;
    return score + pathScore + Math.min(occurrences(content, token), 8);
  }, 0);
}

function bestWindow(document, queryTokens, maxLines) {
  const lines = document.content.split("\n");
  if (lines.length <= maxLines) return { start: 0, lines };

  let best = { score: -1, start: 0 };
  const step = Math.max(1, Math.floor(maxLines / 2));
  for (let start = 0; start < lines.length; start += step) {
    const window = lines.slice(start, start + maxLines).join("\n").toLowerCase();
    const score = queryTokens.reduce(
      (total, token) => total + Math.min(occurrences(window, token), 8),
      0,
    );
    if (score > best.score) best = { score, start };
  }
  return { start: best.start, lines: lines.slice(best.start, best.start + maxLines) };
}

export function retrieveSource(
  index,
  question,
  { repository, limit = 8, maxLines = 90, maxChars = 45_000 } = {},
) {
  const queryTokens = tokens(question);
  const ranked = index.documents
    .filter((document) => !repository || document.repository === repository)
    .map((document) => ({ document, score: scoreDocument(document, queryTokens) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  const chunks = [];
  let usedChars = 0;
  for (const { document, score } of ranked) {
    const window = bestWindow(document, queryTokens, maxLines);
    const numbered = window.lines
      .map((line, indexInWindow) => `${window.start + indexInWindow + 1}: ${line}`)
      .join("\n");
    const content = numbered.slice(0, Math.max(0, maxChars - usedChars));
    if (!content) break;
    chunks.push({
      repository: document.repository,
      path: document.path,
      startLine: window.start + 1,
      score,
      content,
    });
    usedChars += content.length;
    if (usedChars >= maxChars) break;
  }
  return chunks;
}
