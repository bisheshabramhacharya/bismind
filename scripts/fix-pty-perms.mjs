import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// node-pty ships its macOS `spawn-helper` without the executable bit through the
// pnpm store, which makes every spawn fail with "posix_spawnp failed".
const root = join(process.cwd(), 'node_modules', 'node-pty', 'prebuilds');
if (existsSync(root)) {
  for (const dir of readdirSync(root)) {
    const helper = join(root, dir, 'spawn-helper');
    if (existsSync(helper) && !(statSync(helper).mode & 0o111)) {
      chmodSync(helper, 0o755);
      console.log(`[bismind] chmod +x ${helper}`);
    }
  }
}
