#!/usr/bin/env node
/**
 * Read-only capture of whatever a named agent-browser session is currently showing:
 * a full-page screenshot, the structured `inspect` result, and a markdown digest of the
 * visible question types.
 *
 * Why: reviewing real question types is worth a lot for prompt and profile tuning, but it
 * must never cost an attempt. This script only screenshots and reads the DOM. It does not
 * open a page, start a level, expand a card, fill an editor, click Run Check, or submit —
 * point it at a session you have already opened and started yourself.
 *
 * Prefer running it just after you start a level, or after a run has finished, rather than
 * while a timed run is mid-flight: it is a second process on the same browser session and
 * would otherwise compete with the harness for it.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AgentBrowserSession } from "../src/browser/agent-browser.mjs";
import { inspectBrowser } from "../src/browser/runner.mjs";
import { HarnessError, asHarnessError } from "../src/errors.mjs";

function usage() {
  return `Usage:
  npm run review -- --session <name> [--out <directory>] [--allow-origin <origin>]
      [--profile <json>]

Read-only. Screenshots the session's current page and writes the visible question text.
It never opens, starts, expands, fills, checks, or submits anything.`;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new HarnessError(`Unexpected argument: ${argument}`, { code: "INVALID_ARGUMENT" });
    }
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new HarnessError(`--${name} requires a value`, { code: "INVALID_ARGUMENT" });
    }
    options[name] = value;
    index += 1;
  }
  return options;
}

function digest(inspection) {
  const lines = [
    `# Visible questions — ${inspection.title || "untitled page"}`,
    "",
    `- URL: ${inspection.url}`,
    `- Page state: ${inspection.pageState}`,
    `- Cards: ${inspection.cardCount}`,
    `- Final-submit buttons found: ${inspection.submitButtonCount}`,
    "",
  ];
  if (inspection.cardCount === 0) {
    lines.push("No challenge cards are visible on this page.", "");
    lines.push("```json", JSON.stringify(inspection.pageStateEvidence, null, 2), "```");
    return `${lines.join("\n")}\n`;
  }
  for (const card of inspection.cards) {
    lines.push(
      `## ${card.index + 1}. ${card.title}`,
      "",
      `- id: \`${card.id}\``,
      `- editor: ${card.editorKind}`,
      `- check state: ${card.check.state}${card.check.text ? ` (${card.check.text})` : ""}`,
      `- still collapsed: ${card.collapsedRegions} region(s)`,
      "",
      card.prompt || "_(no prompt text captured)_",
      "",
    );
    if (card.starterCode) {
      lines.push("```js", card.starterCode.trim(), "```", "");
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options.session) {
    process.stdout.write(`${usage()}\n`);
    throw new HarnessError("--session is required", { code: "INVALID_ARGUMENT" });
  }
  const outputDirectory = path.resolve(options.out || "review");
  await mkdir(outputDirectory, { recursive: true });

  const browser = new AgentBrowserSession({ session: options.session });
  const location = await browser.location();
  if (options["allow-origin"] && location.origin !== options["allow-origin"]) {
    throw new HarnessError(
      `Browser is at ${location.origin}; expected ${options["allow-origin"]}`,
      { code: "BROWSER_ORIGIN_MISMATCH" },
    );
  }

  const screenshotPath = path.join(outputDirectory, "page.png");
  await browser.command(["screenshot", "--full", screenshotPath], { timeoutMs: 60_000 });

  const profile = options.profile
    ? JSON.parse(await readFile(path.resolve(options.profile), "utf8"))
    : {};
  const inspection = await inspectBrowser({ browser, profile, includePrompts: true });

  const inspectPath = path.join(outputDirectory, "inspect.json");
  const digestPath = path.join(outputDirectory, "questions.md");
  await writeFile(inspectPath, `${JSON.stringify(inspection, null, 2)}\n`, { mode: 0o600 });
  await writeFile(digestPath, digest(inspection), { mode: 0o600 });

  process.stdout.write(`${JSON.stringify({
    url: inspection.url,
    pageState: inspection.pageState,
    cardCount: inspection.cardCount,
    screenshot: screenshotPath,
    inspect: inspectPath,
    questions: digestPath,
    mutated: false,
  }, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const normalized = asHarnessError(error, "REVIEW_FAILED");
    process.stderr.write(`error [${normalized.code}]: ${normalized.message}\n`);
    process.exitCode = 1;
  });
}

export { digest, parseArguments, usage };
