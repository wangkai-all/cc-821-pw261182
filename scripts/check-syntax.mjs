import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = ['src', 'scripts', 'test'];
const files = [];
for (const dir of dirs) {
  for (const entry of readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) {
      files.push(path.join(entry.parentPath ?? entry.path, entry.name));
    }
  }
}

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    console.error(`SYNTAX FAIL: ${path.relative(root, file)}`);
    console.error(result.stderr || result.stdout);
  } else {
    console.log(`ok ${path.relative(root, file)}`);
  }
}
process.exit(failed ? 1 : 0);
