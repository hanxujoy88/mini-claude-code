import fs from "node:fs/promises";
import path from "node:path";
import {
  MODEL,
  PROVIDER,
  SESSION_FILE,
  SESSION_DIR,
  SESSION_ID,
  WORKSPACE
} from "./config.js";

export function createSessionStore({ activeSkillNames, taskPlan, tokenTotals }) {
  async function loadSession() {
    try {
      const raw = await fs.readFile(SESSION_FILE, "utf8");
      const parsed = JSON.parse(raw);
      return {
        restored: true,
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        activeSkillNames: Array.isArray(parsed.activeSkillNames) ? parsed.activeSkillNames : [],
        taskPlan: Array.isArray(parsed.taskPlan) ? parsed.taskPlan : [],
        tokenTotals: parsed.tokenTotals || null
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { restored: false, messages: [] };
      }
      return {
        restored: false,
        messages: [],
        warning: `could not load ${path.relative(WORKSPACE, SESSION_FILE)}: ${error.message}`
      };
    }
  }

  function restoreSessionState(session) {
    for (const name of session.activeSkillNames || []) {
      activeSkillNames.add(name);
    }

    if (Array.isArray(session.taskPlan)) {
      taskPlan.splice(0, taskPlan.length, ...session.taskPlan);
    }

    if (session.tokenTotals) {
      tokenTotals.input = Number(session.tokenTotals.input || 0);
      tokenTotals.output = Number(session.tokenTotals.output || 0);
      tokenTotals.total = Number(session.tokenTotals.total || 0);
    }
  }

  async function saveSession(messages) {
    const payload = {
      version: 1,
      provider: PROVIDER,
      model: MODEL,
      workspace: WORKSPACE,
      sessionId: SESSION_ID,
      updatedAt: new Date().toISOString(),
      messages,
      activeSkillNames: [...activeSkillNames],
      taskPlan,
      tokenTotals
    };
    await fs.mkdir(SESSION_DIR, { recursive: true });
    const tmpFile = `${SESSION_FILE}.tmp`;
    await fs.writeFile(tmpFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await fs.rename(tmpFile, SESSION_FILE);
  }

  return {
    loadSession,
    restoreSessionState,
    saveSession
  };
}
