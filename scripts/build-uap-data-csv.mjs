// build-uap-data-csv.mjs — assemble data-raw/uap-data.csv from the
// public DenisSergeevitch/UFO-USA R01 mirror (162 rows of full
// metadata) plus the 12 R02 records that are verifiable today from
// the war.gov /UFO/ slideshow + the 6 PDFs already committed under
// public/release_2/.
//
// Why this script exists
// ----------------------
// The canonical CSV at
// https://www.war.gov/Portals/1/Interactive/2026/UFO/uap-data.csv
// is currently unreachable from automated paths:
//   1. Akamai returns ERR_ABORTED on direct browser navigation to the
//      CSV URL — it is only served via in-page XHR from
//      https://www.war.gov/UFO/.
//   2. The whipgen MCP web tools (web_open / web_extract / web_search)
//      do not expose a page.evaluate() / JS-eval surface, so they
//      cannot trigger that in-page XHR. (See docs/war-gov-setup.md for
//      the third path — pursue-vision-mcp's war-gov-driver.mjs has the
//      capability but needs an authenticated Chrome on CDP and an
//      egress allowlist that this sandbox does not have.)
//   3. The container egress denies *.war.gov, the CloudFront mirror
//      (d34w7g4gy10iej.cloudfront.net), and web.archive.org with
//      `host_not_allowed`.
//
// So we get R01 from the GitHub-hosted mirror (which IS reachable) and
// hand-encode the R02 rows we can verify from the slideshow thumbnails
// and the committed PDFs. The remaining ~50 R02 video records still
// need either an operator-pulled CSV from war.gov DevTools or a real
// JS-eval surface added to the whipgen web tools.
//
// Output: data-raw/uap-data.csv with N rows where N = 162 (R01 mirror)
// + 12 (R02 verifiable).
//
// Re-run after the canonical CSV becomes available to replace this
// file outright.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const MIRROR_URL =
  "https://raw.githubusercontent.com/DenisSergeevitch/UFO-USA/main/metadata/uap-csv.csv";

// CSV schema (14 named fields + 13 unnamed trailing slots), matching
// the DenisSergeevitch mirror exactly so the R02 rows we append parse
// the same way as the R01 rows.
const HEADER_NAMED = [
  "Redaction",
  "Release Date",
  "Title",
  "Type",
  "Video Pairing",
  "PDF Pairing",
  "Description Blurb",
  "DVIDS Video ID",
  "Video Title",
  "Agency",
  "Incident Date",
  "Incident Location",
  "PDF | Image Link",
  "Modal Image",
];
const TRAILING_EMPTIES = 13;

// R02 release date per config/releases.json.
const R02_DATE = "5/22/26";

const SLIDESHOW = "https://www.war.gov/portals/1/Interactive/2026/UFO/Slideshow-2";

// Verifiable R02 records. Sources:
//   - 5 video thumbnails harvested from the war.gov /UFO/ slideshow
//     (see whipgen_web_extract result, 2026-05-26).
//   - 6 PDFs committed under public/release_2/ (CIA-D001, DOE-D001..D003,
//     DOW-D017, ODNI-D001) — file paths checked in repo HEAD.
//   - 1 audio thumbnail (NASA-UAP-D008) from the same slideshow.
// Field semantics match the R01 mirror: Title is the canonical
// AGENCY-UAP-NNN id, Video Title carries the human-readable headline
// when present, PDF | Image Link points at the local repo path when
// the asset is committed and to the war.gov URL otherwise.
const R02_RECORDS = [
  {
    Title: "DOW-UAP-PR050",
    Type: "Video",
    DescriptionBlurb:
      "4 UAP in formation observed over water by CENTCOM operator, Iran, 26 August 2022.",
    VideoTitle:
      "4 UAP Formation Iran 26 Aug 2022 over water [CALLSIGN]",
    Agency: "Department of War",
    IncidentDate: "8/26/22",
    IncidentLocation: "Iran",
    ModalImage: `${SLIDESHOW}/DOW-UAP-PR050_4UAP_Formation_Iran_26_Aug_2022.jpg`,
  },
  {
    Title: "DOW-UAP-PR051",
    Type: "Video",
    DescriptionBlurb:
      "Syrian UAP demonstrating instant acceleration, CENTCOM, 2021.",
    VideoTitle: "Syrian UAP instant acceleration",
    Agency: "Department of War",
    IncidentDate: "2021",
    IncidentLocation: "Syria (CENTCOM)",
    ModalImage: `${SLIDESHOW}/DOW-UAP-PR051.jpg`,
  },
  {
    Title: "DOW-UAP-PR052",
    Type: "Video",
    DescriptionBlurb: "",
    VideoTitle: "",
    Agency: "Department of War",
    IncidentDate: "",
    IncidentLocation: "",
    ModalImage: `${SLIDESHOW}/DOW-UAP-PR052.jpg`,
  },
  {
    Title: "DOW-UAP-PR071",
    Type: "Video",
    DescriptionBlurb:
      "USAF-ANG F-16C (callsign [CALLSIGN]) shoots down UAP.",
    VideoTitle: "USAF-ANG F-16C [CALLSIGN] Shoots Down UAP",
    Agency: "Department of War",
    IncidentDate: "",
    IncidentLocation: "",
    ModalImage: `${SLIDESHOW}/DOW-UAP-PR071_USAF-ANG%20F-16C_callsign_CALLSIGN_Shoots_Down_UAP.jpg`,
  },
  {
    Title: "DOW-UAP-PR086",
    Type: "Video",
    DescriptionBlurb: "UAP from December 2019 East Coast.",
    VideoTitle: "UAP from Dec 2019 East Coast",
    Agency: "Department of War",
    IncidentDate: "12/2019",
    IncidentLocation: "East Coast",
    ModalImage: `${SLIDESHOW}/DOW-UAP-PR086-UAP_from_Dec_2019_East_Coast.jpg`,
  },
  {
    Title: "CIA-UAP-D001",
    Type: "PDF",
    DescriptionBlurb:
      "CIA Intelligence Information Report on a UAP sighting in the USSR, 20 December 1973.",
    Agency: "CIA",
    IncidentDate: "12/20/73",
    IncidentLocation: "USSR",
    PdfImageLink:
      "public/release_2/CIA-UAP-D001_Intelligence_Information_Report_USSR_1973.pdf",
    ModalImage: `${SLIDESHOW}/CIA-UAP-D001_Intelligence_Information_Report_USSR_1973.jpg`,
  },
  {
    Title: "DOE-UAP-D001",
    Type: "PDF",
    DescriptionBlurb: "Enhanced PANTEX imagery.",
    Agency: "DOE",
    IncidentDate: "",
    IncidentLocation: "N/A",
    PdfImageLink: "public/release_2/DOE-UAP-D001_PANTEX_Image.pdf",
    ModalImage: `${SLIDESHOW}/DOE-UAP-D001_PANTEX_Image.jpg`,
  },
  {
    Title: "DOE-UAP-D002",
    Type: "PDF",
    DescriptionBlurb: "James Tuck correspondence.",
    Agency: "DOE",
    IncidentDate: "",
    IncidentLocation: "N/A",
    PdfImageLink:
      "public/release_2/DOE-UAP-D002_JamesTuck_Correspondence.pdf",
    ModalImage: "",
  },
  {
    Title: "DOE-UAP-D003",
    Type: "PDF",
    DescriptionBlurb: "Pajarito Astronomers.",
    Agency: "DOE",
    IncidentDate: "",
    IncidentLocation: "N/A",
    PdfImageLink: "public/release_2/DOE-UAP-D003_Pajarito_Astronomers.pdf",
    ModalImage: "",
  },
  {
    Title: "DOW-UAP-D017",
    Type: "PDF",
    DescriptionBlurb:
      "UAP reported at Sandia Base (General Correspondence Of Sandia).",
    Agency: "Department of War",
    IncidentDate: "1948-1950",
    IncidentLocation: "New Mexico",
    PdfImageLink:
      "public/release_2/DOW-UAP-D017_General_Correspondence_Of_Sandia.pdf",
    ModalImage: `${SLIDESHOW}/DOW-UAP-D017_General_Correspondence_Of_Sandia.jpg`,
  },
  {
    Title: "ODNI-UAP-D001",
    Type: "PDF",
    DescriptionBlurb:
      "USPER Narrative, Senior USIC (Western US, 2025).",
    Agency: "ODNI",
    IncidentDate: "2025",
    IncidentLocation: "Western United States",
    PdfImageLink:
      "public/release_2/ODNI-UAP-D001_USPER_Narrative_Senior_USIC.pdf",
    ModalImage: `${SLIDESHOW}/ODNI-UAP-D001_USPER_Narrative_Senior_USIC.jpg`,
  },
  {
    Title: "NASA-UAP-D008",
    Type: "Audio",
    DescriptionBlurb: "Apollo 12 Medical Debriefing - Tape 12.",
    Agency: "NASA",
    IncidentDate: "1969",
    IncidentLocation: "Texas",
    PdfImageLink: "",
    ModalImage: `${SLIDESHOW}/NASA-UAP-D008_Apollo12_Medical_Debriefing.jpg`,
  },
];

// RFC4180-ish escape. The mirror only quotes fields containing commas,
// quotes, or newlines, so we match that. Embedded double-quotes are
// doubled per RFC4180.
function csvField(v) {
  const s = v == null ? "" : String(v);
  if (s === "") return "";
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function r02Row(rec) {
  const cells = [
    "", // Redaction
    R02_DATE, // Release Date
    rec.Title,
    rec.Type,
    "", // Video Pairing
    "", // PDF Pairing
    rec.DescriptionBlurb || "",
    "", // DVIDS Video ID — unknown until canonical CSV available
    rec.VideoTitle || "",
    rec.Agency || "",
    rec.IncidentDate || "",
    rec.IncidentLocation || "",
    rec.PdfImageLink || "",
    rec.ModalImage || "",
  ];
  while (cells.length < HEADER_NAMED.length + TRAILING_EMPTIES) cells.push("");
  return cells.map(csvField).join(",");
}

async function fetchMirror() {
  const r = await fetch(MIRROR_URL);
  if (!r.ok) throw new Error(`mirror fetch failed: ${r.status}`);
  return await r.text();
}

const r01Csv = await fetchMirror();
// The mirror's trailing newline is inconsistent across releases — normalize.
const r01Trimmed = r01Csv.replace(/\s+$/, "") + "\n";
const r02Rows = R02_RECORDS.map(r02Row).join("\n") + "\n";
const combined = r01Trimmed + r02Rows;

await mkdir(path.join(ROOT, "data-raw"), { recursive: true });
const outPath = path.join(ROOT, "data-raw", "uap-data.csv");
await writeFile(outPath, combined, "utf8");

// Sanity counts.
const r01Records = r01Csv.split(/\n(?=,?(?:TRUE|),5\/8\/26,)/g).length;
const r02Records = R02_RECORDS.length;
console.log(`wrote ${outPath}`);
console.log(`  R01 (mirror, parsed-by-anchor): ~${r01Records} records`);
console.log(`  R02 (verifiable):                ${r02Records} records`);
console.log(`  combined bytes:                  ${combined.length}`);
