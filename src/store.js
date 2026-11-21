import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({
  items: {},
  amazonCache: {},
  overrides: {},
  settings: {},
  lookupUsage: { date: '', count: 0 },
  alerted: {},
  lastPoll: null,
});

/** Tiny JSON-file store. Writes are debounced and atomic (temp file + rename). */
export function openStore(file) {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  let data = EMPTY();
  if (fs.existsSync(abs)) {
    try {
      data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(abs, 'utf8')) };
    } catch (err) {
      const backup = `${abs}.corrupt-${Date.now()}`;
      fs.renameSync(abs, backup);
      console.error(`Could not parse ${abs} (${err.message}); moved it to ${backup} and started fresh.`);
    }
  }

  let timer = null;
  function flush() {
    clearTimeout(timer);
    timer = null;
    const tmp = `${abs}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, abs);
  }

  return {
    get data() {
      return data;
    },
    save() {
      if (!timer) timer = setTimeout(flush, 500);
    },
    flush,
  };
}
