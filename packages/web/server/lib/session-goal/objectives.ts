
import fs from 'fs';
import os from 'os';
import path from 'path';

export type ObjectiveContent = string | number | boolean | null | ObjectiveContent[] | { [key: string]: ObjectiveContent };

export const GOAL_OBJECTIVE_CHAR_LIMIT = 5_000;

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

const goalsDir = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'goals',
);

const objectiveFilePath = (sessionId: string) => path.join(goalsDir(), `${sessionId}.md`);

const isValidObjectiveKey = (sessionId: unknown): sessionId is string =>
  typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId);

const clampContent = (content: ObjectiveContent | undefined) => String(content ?? '').trim().slice(0, GOAL_OBJECTIVE_CHAR_LIMIT);

const validateObjective = (sessionId: string, content: ObjectiveContent | undefined) => {
  if (!isValidObjectiveKey(sessionId)) {
    throw Object.assign(new Error('invalid session id'), { statusCode: 400 });
  }
  const text = clampContent(content);
  if (!text) {
    throw Object.assign(new Error('objective content is required'), { statusCode: 400 });
  }
  return text;
};

export const writeObjective = async (sessionId: string, content: ObjectiveContent | undefined) => {
  const text = validateObjective(sessionId, content);
  await fs.promises.mkdir(goalsDir(), { recursive: true });
  await fs.promises.writeFile(objectiveFilePath(sessionId), text, 'utf8');
  return { content: text };
};

export const copyObjectiveIfAbsent = async (sessionId: string, content: ObjectiveContent | undefined) => {
  const text = validateObjective(sessionId, content);
  await fs.promises.mkdir(goalsDir(), { recursive: true });
  const temporary = await fs.promises.mkdtemp(path.join(goalsDir(), '.fork-'));
  try {
    const source = path.join(temporary, 'objective.md');
    await fs.promises.writeFile(source, text, 'utf8');
    try {
      await fs.promises.link(source, objectiveFilePath(sessionId));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  } finally {
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
};

export const readObjective = async (sessionId: string) => {
  if (!isValidObjectiveKey(sessionId)) return null;
  try {
    const raw = await fs.promises.readFile(objectiveFilePath(sessionId), 'utf8');
    return clampContent(raw);
  } catch {
    return null;
  }
};

export const deleteObjective = async (sessionId: string) => {
  if (!isValidObjectiveKey(sessionId)) return;
  await fs.promises.unlink(objectiveFilePath(sessionId)).catch(() => undefined);
};
