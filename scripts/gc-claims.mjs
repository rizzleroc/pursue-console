import { gcClaims, CLAIMS_DIR } from "./claim-page.mjs";
import { readdir, rmdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const { removed, kept } = await gcClaims();
console.log(`[gc-claims] removed ${removed} expired · kept ${kept} active`);

// Remove empty event directories (no .json files left).
if (existsSync(CLAIMS_DIR)) {
  const eids = (await readdir(CLAIMS_DIR, { withFileTypes: true })).filter(d => d.isDirectory());
  for (const eidEnt of eids) {
    const eidDir = path.join(CLAIMS_DIR, eidEnt.name);
    const jsonFiles = (await readdir(eidDir)).filter(f => /\.json$/.test(f));
    if (jsonFiles.length === 0) {
      await rmdir(eidDir);
    }
  }
}

process.exit(0);
