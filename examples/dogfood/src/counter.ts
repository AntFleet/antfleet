import { readFile, writeFile } from "node:fs/promises";

const STATE_PATH = ".counter-state.json";

type Counter = {
  count: number;
  updatedAt: string;
};

async function readCounter(): Promise<Counter> {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    return JSON.parse(raw) as Counter;
  } catch {
    return { count: 0, updatedAt: new Date(0).toISOString() };
  }
}

async function writeCounter(counter: Counter): Promise<void> {
  await writeFile(STATE_PATH, JSON.stringify(counter), "utf8");
}

export async function increment(): Promise<Counter> {
  const current = await readCounter();
  const next: Counter = {
    count: current.count + 1,
    updatedAt: new Date().toISOString(),
  };
  await writeCounter(next);
  return next;
}

export async function bulkIncrement(times: number): Promise<Counter> {
  const tasks: Promise<Counter>[] = [];
  for (let i = 0; i < times; i++) {
    tasks.push(increment());
  }
  const results = await Promise.all(tasks);
  const last = results[results.length - 1];
  if (last === undefined) {
    throw new Error("no increments ran");
  }
  return last;
}
