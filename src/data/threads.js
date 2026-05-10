// =================================================================
// THREADS — curated narrative arcs through the corpus.
// Each thread is an ordered sequence of event ids, plus a thesis.
// =================================================================
export const THREADS = [
  {
    id: "wwii-to-cold-war",
    title: "Foo Fighters → Flying Discs → Project Sign",
    thesis: "The earliest official records cluster on a single observation: the war was producing things that flew differently than they should. SHAEF's 'foo fighters' over Germany and a 1944 witness recounting a circular vertical-takeoff vehicle become formal Air Materiel Command concern within months of Roswell, then standardized procedure under Project Sign by 1948.",
    events: ["shaef-1945","krasuski-1944","fbi-62hq83894","amc-1947","general-1948","netherlands-1948","1949-discs"],
    color: "#FFD93D",
  },
  {
    id: "blue-book-era",
    title: "The Bureaucracy of Sightings (1950s–60s)",
    thesis: "Once UFOs stopped being a wartime puzzle, the US government tried to file them. 233 standardized incident summaries, a State Department memo on the 1952 Washington flap, USAF cross-border intelligence on a USSR sighting, and an FBI memo from a man in Detroit describing a 'crystal-type dome' — all funneling toward a question the Executive Office finally asked openly in 1963.",
    events: ["incident-summaries","state-1952","azerbaijan-1955","detroit-1958","presidential-1963"],
    color: "#FF8C42",
  },
  {
    id: "nasa-arc",
    title: "The NASA Arc: Borman to Apollo 17",
    thesis: "Astronauts saw things. Borman's 'bogey' on Gemini VII. Aldrin's three observations on Apollo 11. Bean's particles 'escaping the Moon' through the AOT and Conrad's debris on Apollo 12. Then Apollo 17 — three dots in triangular formation, original film recovered, ACTIVE DOW INVESTIGATION. Skylab crews saw a red satellite they couldn't account for. The thread ends with the COMETA report — French generals telling Washington in 2001 that this was a defense problem.",
    events: ["gemini-7","apollo-11","apollo-12","apollo-17","skylab","cometa"],
    color: "#82B6FF",
  },
  {
    id: "diplomatic",
    title: "State Department Cables: UFOs as Statecraft",
    thesis: "When governments other than ours encountered UAP, US embassies cabled home. Air Niugini radar contacts, a Tajik 747 photographing 90° turns at 41,000 feet, Russia using UFOs to deny bombing the Kodori Gorge, the Mexican Congress nearly passing an Aerial Space Protection Law, and a wry Ashgabat note treating UFOlogists as civil-society partners. The phenomenon had become a diplomatic instrument.",
    events: ["papua-1985","kazakhstan-1994","georgia-2001","mexico-2003","turkmenistan-2004"],
    color: "#FFD93D",
  },
  {
    id: "centcom-cluster",
    title: "The CENTCOM Cluster (2016–2024)",
    thesis: "The bulk of Release 01's modern videos come from a single command. Sea-skim tracking off Latakia, the 2020 Arabian Gulf cluster, multiple Iraq/Syria/Greece encounters, a SWIR-only diamond, a 7-minute bouncy-ball track, and a Halo-effect cluster. Each individually inconclusive; together a sustained collection signature centered on the Middle East.",
    events: ["syria-2016","middle-east-may-2020","arabian-gulf-2020","gulf-aden-sept-2020","iraq-may-2022","kuwait-may-2022","iraq-may-29-2022","syria-july-2022","iraq-dec-2022","syria-feb-2023","greece-oct-2023","syria-nov-2023","greece-jan-2024","gulf-aden-jul-2024","iraq-sept-2024","syria-oct-2024","uae-oct-2023","uae-june-2024"],
    color: "#7CFFB2",
  },
  {
    id: "concrete-corroboration",
    title: "The Hard Cases (2023–2025)",
    thesis: "AARO's strongest endorsements live here. Seven federal employees in the Western US describe orbs launching orbs and a translucent kite over two days. Three FBI 302s describe an ellipsoid bronze object materializing and disappearing instantaneously. 32 government still images. And — exceptionally — a senior US intelligence official giving a first-hand account of a super-hot orb evading helicopter pursuit at a US military facility.",
    events: ["western-us-2023","ellipsoid-2023","fbi-photos-2025","usper-2025","army-2026"],
    color: "#FFD93D",
  },
  {
    id: "morphology-zoo",
    title: "What the Objects Look Like",
    thesis: "The release's morphological catalog runs from 1944 (vertical-takeoff circular) to 2024 (football with three radial projections). Diamond + probe, inverted teardrop, ellipsoid bronze, bouncy ball, translucent kite, three dots in triangular formation. No single shape dominates — but the absence of consistency may itself be the signal.",
    events: ["krasuski-1944","apollo-17","ellipsoid-2023","greece-jan-2024","indopacom-2024","uae-june-2024","syria-nov-2023","western-us-2023","detroit-1958"],
    color: "#7CFFB2",
  },
  {
    id: "sensor-modality",
    title: "Visible-Only-In",
    thesis: "Several cases turn on the sensor that saw them. Greece Jan 2024: visible only in SWIR — switching modalities loses the object. Black-hot IR for a cold round object in the Gulf of Aden. AOT for Apollo 12's particles. The release suggests phenomena indexed by detection modality, not by the eye.",
    events: ["greece-jan-2024","gulf-aden-sept-2020","apollo-12","syria-2016","middle-east-may-2020"],
    color: "#B794F4",
  },
];
