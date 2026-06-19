// Emit public/i18n/<code>.json for every src/i18n/locales/*.js plus
// public/i18n/languages.json. Lets the static /mc/ surfaces consume
// the same translation strings the React app uses without going
// through the Vite build.
//
// Output:
//   public/i18n/en.json, public/i18n/fr.json, … (one per locale)
//   public/i18n/languages.json — array of {code, native, dir}
import { writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "public", "i18n");
const SRC_LOCALES = path.join(ROOT, "src", "i18n", "locales");

await mkdir(OUT_DIR, { recursive: true });

const files = (await readdir(SRC_LOCALES)).filter((f) => f.endsWith(".js"));
for (const f of files) {
  const code = f.replace(/\.js$/, "");
  const mod = await import(path.join(SRC_LOCALES, f));
  const data = mod.default || {};
  await writeFile(path.join(OUT_DIR, `${code}.json`), JSON.stringify(data));
}

// languages.js exports LANGUAGES = [{code, native, dir}].
const langMod = await import(path.join(ROOT, "src/i18n/languages.js"));
await writeFile(
  path.join(OUT_DIR, "languages.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), languages: langMod.LANGUAGES || [] })
);

console.log(`[i18n-public] wrote ${files.length} locales + languages.json to public/i18n/`);
