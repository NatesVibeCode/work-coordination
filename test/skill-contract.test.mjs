import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The skill is documentation an agent will follow literally, so its examples
// must be real. This reads the command table out of the CLI itself and checks
// every example in skills/work-coordination against it: no invented verb, no
// invented flag, no flag used on a command that does not accept it. Changing
// the CLI without changing the skill (or the reverse) fails here.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const binPath = join(root, "bin", "work-coordination.mjs");
const skillDir = join(root, "skills", "work-coordination");
const source = readFileSync(binPath, "utf8");

// Read the command table out of the CLI itself by evaluating the real thing,
// rather than pattern-matching it. The slices are the CLI's own literal
// source, concatenated (never interpolated) into a wrapper, so its template
// strings and backticks survive intact.
function commandTable() {
  const helpers = source.slice(source.indexOf('const WRITE = "write";'), source.indexOf("const COMMANDS = {"));
  const literal = source.slice(source.indexOf("const COMMANDS = {"), source.indexOf("class UsageError"));
  const program = `${helpers}\n${literal}\nreturn COMMANDS;`;
  return new Function(program)();
}

const RAW_COMMANDS = commandTable();

// Normalized view: name -> { flags: Set, subcommands: Set, mode }.
const COMMANDS = new Map(Object.entries(RAW_COMMANDS).map(([name, command]) => [
  name,
  {
    flags: new Set((command.flags ?? []).map((flag) => flag.name)),
    subcommands: new Set(Object.keys(command.subcommands ?? {})),
    mode: command.mode,
  },
]));

// Fenced blocks that show shell invocations, including `\` continuations.
function shellExamples(text) {
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map((value) => value[1]);
  return blocks
    .flatMap((block) => block.split(/\n(?=\s*work-coordination|\s*#)/))
    .flatMap((entry) => entry.split(/\\\n/))
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.startsWith("work-coordination"));
}

function globalFlags() {
  return new Set(["--state"]);
}

function tokensOf(line) {
  return line.replace(/^work-coordination\s*/, "").split(/\s+/).filter(Boolean);
}

function isPlaceholder(token) {
  return /^<.*>$/.test(token) || /^["'].*["']$/.test(token);
}

test("the skill exists with frontmatter and its references", () => {
  const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter, "SKILL.md needs YAML frontmatter");
  assert.match(frontmatter[1], /^name: work-coordination$/m);
  assert.match(frontmatter[1], /^description: .{40,}$/m);

  for (const reference of ["cli-contract.md", "coordination-model.md", "mcp-setup.md"]) {
    const body = readFileSync(join(skillDir, "references", reference), "utf8");
    assert.ok(body.length > 500, `${reference} looks empty`);
  }
  // Every referenced file is named in the entry point.
  for (const reference of ["cli-contract.md", "coordination-model.md", "mcp-setup.md"]) {
    assert.match(skill, new RegExp(reference.replace(".", "\\.")));
  }
});

test("every command in the skill is a real command", () => {
  const commands = ["SKILL.md", "references/cli-contract.md", "references/coordination-model.md", "references/mcp-setup.md"]
    .flatMap((file) => shellExamples(readFileSync(join(skillDir, file), "utf8")));

  assert.ok(commands.length >= 10, `expected real examples, found ${commands.length}`);
  for (const line of commands) {
    const [verb] = tokensOf(line);
    // A bare invocation is the documented "nothing to do" case, not a verb.
    if (!verb) continue;
    assert.ok(COMMANDS.has(verb), `unknown command in skill example: ${verb} (${line})`);
  }
});

test("every flag in the skill is accepted by the command that uses it", () => {
  const files = ["SKILL.md", "references/cli-contract.md", "references/coordination-model.md", "references/mcp-setup.md"];
  const known = new Set([...globalFlags()]);
  for (const { flags } of COMMANDS.values()) for (const flag of flags) known.add(flag);

  for (const file of files) {
    for (const line of shellExamples(readFileSync(join(skillDir, file), "utf8"))) {
      const tokens = tokensOf(line);
      const command = tokens[0];
      if (!COMMANDS.has(command)) continue; // covered by the command test
      const action = tokens[1] && !tokens[1].startsWith("-") && COMMANDS.get(command).subcommands.has(tokens[1]) ? tokens[1] : null;
      const accepted = new Set([...COMMANDS.get(command).flags, ...globalFlags()]);
      for (const token of tokens) {
        const name = token.split("=")[0];
        if (!name.startsWith("--")) continue;
        assert.ok(known.has(name), `invented flag in skill example: ${name} (${file})`);
        assert.ok(
          accepted.has(name) || globalFlags().has(name),
          `${command}${action ? ` ${action}` : ""} does not accept ${name} (${file})`,
        );
      }
    }
  }
});

test("commands the skill tells an agent to use are the ones the CLI reads", () => {
  const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  // The four moves plus the group and lane lifecycle must all appear.
  for (const verb of ["observe", "message", "work", "sessions", "groups", "subscriptions", "group", "ungroup", "subscribe", "unsubscribe"]) {
    assert.match(skill, new RegExp(`work-coordination (${verb}\\b|group ${verb}\\b)`), `SKILL.md never shows ${verb}`);
  }
  // And the statuses it names are the statuses the system fans out on.
  assert.match(skill, /Only `blocked` and `done` fan out/);
  for (const status of ["started", "milestone", "blocked", "done"]) {
    assert.match(skill, new RegExp(`\`${status}\``));
  }
});

test("the CLI contract in the skill matches the CLI's own tables", () => {
  const contract = readFileSync(join(skillDir, "references", "cli-contract.md"), "utf8");
  for (const [name, { flags, subcommands, mode }] of COMMANDS) {
    // The name appears in the contract's table, alone or as `a b` pairs.
    assert.match(contract, new RegExp(`\`[^\`]*\\b${name}\\b[^\`]*\``), `cli-contract.md omits ${name}`);
    for (const subcommand of subcommands) {
      assert.match(contract, new RegExp(`${name} ${subcommand}`), `cli-contract.md omits ${name} ${subcommand}`);
    }
    for (const flag of flags) {
      assert.match(contract, new RegExp(flag.slice(2)), `cli-contract.md omits ${flag} for ${name}`);
    }
    // Mode words must match what the table declares, so the skill cannot tell
    // an agent that a writing command is read-only or the reverse.
    assert.match(contract, new RegExp(`\`${name}( [a-z]+)?\`[^\\n]*\\|\\s*${mode === "write" ? "writes" : "reads"}`), `${name} mode is misstated in cli-contract.md`);
  }
});

test("the skill keeps the vocabulary straight, including what a lane is not", () => {
  const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const model = readFileSync(join(skillDir, "references", "coordination-model.md"), "utf8");

  // A session read this skill and could not work out what to do, because the
  // skill taught "subscribe a lane" as if this tool owned lanes. A lane is a
  // process the host harness spawns; this tool only ever sees the session it
  // registers as. The four real words must be defined, and the impostor must
  // be named as not one of ours.
  for (const word of ["**work**", "**session**", "**group**", "**subscription**"]) {
    assert.match(skill, new RegExp(word.replace(/\*/g, "\\*")), `the skill must define ${word}`);
  }
  assert.match(skill, /A lane is none of these/);
  assert.match(skill, /no lane command/, "and must say there are no lane commands");
  assert.match(skill, /lanes\/<name>\.json/, "and must name the third meaning so it is not confused");

  // The tool's own output must not call a subscription a lane either. The one
  // section allowed to say "lane" is the disambiguation itself — that is where
  // it is being explained.
  const withoutGlossary = (text) => {
    const start = text.indexOf("## Words that mean something specific");
    if (start < 0) return text;
    const end = text.indexOf("\n## ", start + 1);
    return `${text.slice(0, start)}${end < 0 ? "" : text.slice(end)}`;
  };
  for (const [file, text] of [["SKILL.md", skill], ["coordination-model.md", model]]) {
    for (const line of withoutGlossary(text).split("\n")) {
      assert.equal(/\blane/i.test(line), false, `"lane" used outside the glossary in ${file}: ${line.trim()}`);
    }
  }
});

test("the skill never promises control it does not have", () => {
  const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  // Banned phrasings: the tool is advisory-only by design.
  for (const banned of [/\block\b/i, /\blease\b/i, /\bclaim the work\b/i, /\bassign\b/i, /\bsteer\b/i]) {
    if (banned.test(skill)) {
      // Mentioning them as things the system does not do is fine; promising
      // them is not. Require a nearby negation for each hit.
      const index = skill.search(banned);
      const window = skill.slice(Math.max(0, index - 120), index + 160);
      assert.match(window, /\bnot\b|\bnever\b|\bno\b/i, `skill promises ${banned} near: ${window.trim()}`);
    }
  }
});
