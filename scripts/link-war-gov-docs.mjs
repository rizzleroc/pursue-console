// Recreate data-raw/<ID>.<ext> symlinks for war.gov release documents.
//
// The durable copies live in data-raw/war-gov/release_N/ (tracked in git);
// the ID-named files at the data-raw root are gitignored (data-raw/* rule
// that keeps the ~780MB of Release 01 PDFs out of the repo). Every script
// that resolves a document by event id — build-text-files, vision-ocr,
// classify-visuals, render passes — reads data-raw/<ID>.pdf, so a fresh
// clone silently skips war.gov docs until these links exist again.
//
// Idempotent; safe on every build. Runs before build-text-files in the
// npm build chain.
import { readdir, symlink, rm, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.resolve(__dirname, "..", "data-raw");
const WAR = path.join(RAW, "war-gov");

// Event ids that differ from the id embedded in the release filename.
// FBI-UAP-D014 exists in both R03 and R04 as different documents; the R04
// catalog entry is suffixed -R04, so its file must link under that name
// or R03's id silently picks up R04's correspondence file.
const ID_OVERRIDES = { "release_4/FBI-UAP-D014": "FBI-UAP-D014-R04" };

let made = 0, kept = 0;
if (existsSync(WAR)) {
  for (const dir of await readdir(WAR)) {
    if (!/^release_\d+$/.test(dir)) continue;
    for (const f of await readdir(path.join(WAR, dir))) {
      const m = f.match(/^([A-Z]+-UAP-(?:D|PR)\d+[A-Za-z]?)_.*\.(pdf|jpg|png)$/);
      if (!m) continue;
      const id = ID_OVERRIDES[`${dir}/${m[1]}`] || m[1];
      const linkPath = path.join(RAW, `${id}.${m[2]}`);
      const target = path.join("war-gov", dir, f);   // relative — survives repo moves
      try {
        const st = await lstat(linkPath).catch(() => null);
        if (st) {
          if (existsSync(linkPath)) { kept++; continue; }  // healthy file or link
          await rm(linkPath);                              // dangling link — replace
        }
        await symlink(target, linkPath);
        made++;
      } catch (e) {
        console.warn(`[link-war-gov] ${m[1]}: ${e.message}`);
      }
    }
  }
}
console.log(`[link-war-gov] created ${made} symlink(s), ${kept} already present`);
