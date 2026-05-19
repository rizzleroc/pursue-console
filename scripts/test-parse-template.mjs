// Tests for parseTemplate() inside volunteer-media.mjs.
// Reimplements the function here so we can test it without spawning
// the full claim/commit dance.
//
// Run: node scripts/test-parse-template.mjs
// Exit 0 on all pass, 1 on any fail.

function parseTemplate(md) {
  // Strip BOM if present (word processors / "Save as UTF-8" with
  // signature on Windows). Without this the first heading line reads
  // ﻿# Kind, fails the ^# regex, and the section silently drops.
  const sections = {};
  let current = null, buf = [];
  for (const line of md.replace(/^﻿/, "").split(/\r?\n/)) {
    const h = line.match(/^# (.+?)\s*$/);
    if (h) {
      if (current) sections[current] = buf.join("\n").trim();
      current = h[1].toLowerCase();
      buf = [];
      continue;
    }
    if (current) buf.push(line);
  }
  if (current) sections[current] = buf.join("\n").trim();
  for (const k of Object.keys(sections)) sections[k] = sections[k].replace(/<!--[\s\S]*?-->/g, "").trim();
  return sections;
}

let pass = 0, fail = 0;
function test(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else    { fail++; console.log(`  ✗ ${name}`); console.log(`    expected: ${JSON.stringify(expected)}`); console.log(`    actual:   ${JSON.stringify(actual)}`); }
}

console.log("[parseTemplate]");

test("basic LF",
  parseTemplate("# Kind\nphotograph\n# Title\nA test\n# Context\nThe witness saw.\n"),
  { kind: "photograph", title: "A test", context: "The witness saw." });

test("CRLF line endings",
  parseTemplate("# Kind\r\nmap\r\n# Title\r\nA map\r\n# Context\r\nNW quadrant.\r\n"),
  { kind: "map", title: "A map", context: "NW quadrant." });

test("HTML comment in body is stripped",
  parseTemplate("# Title\n<!-- placeholder -->Actual title\n# Context\nReal context"),
  { title: "Actual title", context: "Real context" });

test("Multi-line HTML comment",
  parseTemplate("# Title\n<!--\nline one\nline two\n-->Real value"),
  { title: "Real value" });

test("Empty section yields empty string",
  parseTemplate("# Kind\nphotograph\n# Title\n\n# Context\nfoo"),
  { kind: "photograph", title: "", context: "foo" });

test("Whitespace-only section after comment strip yields empty",
  parseTemplate("# Title\n<!-- placeholder -->\n\n  \n# Context\nfoo"),
  { title: "", context: "foo" });

test("No # headers at all yields empty object",
  parseTemplate("just some text\nnothing structured"),
  {});

test("Stray heading prefix not at line start is ignored",
  parseTemplate("# Title\nhello\nthe # symbol is fine\n# Context\nbar"),
  { title: "hello\nthe # symbol is fine", context: "bar" });

test("Trailing newline tolerated",
  parseTemplate("# Kind\nmap\n\n\n"),
  { kind: "map" });

test("Section header case is lowercased",
  parseTemplate("# KIND\nMAP\n# TITLE\nFOO"),
  { kind: "MAP", title: "FOO" });

test("Newspaper article section with hyphens in heading name",
  parseTemplate("# Article text (newspaper-clipping ONLY)\nThe headline\nThe body"),
  { "article text (newspaper-clipping only)": "The headline\nThe body" });

test("BOM at start of file does not break first heading",
  parseTemplate("﻿# Kind\nphotograph"),
  // BOM is preserved on the line before any heading is matched; the
  // first non-empty heading sets the section. This test documents that
  // the BOM line is silently ignored because no `current` is set yet.
  { kind: "photograph" });

console.log(`\n[parseTemplate] ${pass} passed · ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
