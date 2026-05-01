import fs from "node:fs/promises";
import path from "node:path";
import { WORKSPACE } from "./config.js";

export async function loadSkills() {
  const skillsDir = path.join(WORKSPACE, "skills");
  let entries = [];
  try {
    entries = await fs.readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const loaded = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const filePath = path.join(skillsDir, entry.name, "SKILL.md");
    try {
      const raw = await fs.readFile(filePath, "utf8");
      loaded.push(parseSkill(raw, entry.name, filePath));
    } catch (error) {
      console.warn(`[skills] skipped ${entry.name}: ${error.message}`);
    }
  }

  return loaded.sort((a, b) => a.name.localeCompare(b.name));
}

export function matchSkills(skills, text) {
  if (skills.length === 0) return [];

  const queryTokens = tokenize(`${text}`);
  if (queryTokens.length === 0) return [];

  const scored = skills.map((skill) => {
    const haystackTokens = tokenize(`${skill.name} ${skill.description}`);
    const score = queryTokens.reduce((sum, token) => {
      if (haystackTokens.includes(token)) return sum + 2;
      if (haystackTokens.some((candidate) => candidate.includes(token) || token.includes(candidate))) return sum + 1;
      return sum;
    }, 0);
    return { skill, score };
  });

  return scored
    .filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((item) => item.skill);
}

export function buildSkillContext(matchedSkills) {
  return [
    "The following skill instructions were auto-selected for the next user request. Treat them as task guidance, not user-authored content.",
    ...matchedSkills.map((skill) => [
      `<skill name="${skill.name}" path="${path.relative(WORKSPACE, skill.filePath)}">`,
      skill.body,
      "</skill>"
    ].join("\n"))
  ].join("\n\n");
}

function parseSkill(raw, fallbackName, filePath) {
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = {};
  let body = raw;

  if (frontmatter) {
    body = raw.slice(frontmatter[0].length);
    for (const line of frontmatter[1].split("\n")) {
      const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (match) {
        meta[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
      }
    }
  }

  const name = meta.name || fallbackName;
  const description = meta.description || firstParagraph(body) || "No description.";
  return {
    name,
    description,
    body: body.trim(),
    filePath
  };
}

function firstParagraph(text) {
  return text.split(/\n\s*\n/).map((part) => part.trim()).find(Boolean) || "";
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}
