# IntentChord — Public Asset and Dependency Rights Inventory

Inventory date: 2026-11-01. This is a publication due-diligence record, not a title search, legal clearance or legal opinion.

## Visual assets in the published source

The Owner has stated that the original IntentChord identity and project are his own work and that no human co-owner contributed to the original project. This is an **owner declaration**, not independent chain-of-title evidence for every underlying embedded image or design layer.

| Shipped file | Size (bytes) | SHA-256 prefix | Origin/status |
| --- | ---: | --- | --- |
| public/apple-touch-icon.png | 31683 | 20E64CAB2886F2F4 | Owner-declared original brand/visual export; source-layer provenance not independently verified |
| public/favicon.ico | 907 | 7D4028E31E47D2D1 | Owner-declared original brand/visual export; source-layer provenance not independently verified |
| public/intentchord-assets/favicon-16x16.png | 885 | 7AFF797077215D94 | Owner-declared original brand/visual export; source-layer provenance not independently verified |
| public/intentchord-assets/favicon-32x32.png | 2411 | A4E8DBFB502F5194 | Owner-declared original brand/visual export; source-layer provenance not independently verified |
| public/intentchord-assets/favicon.svg | 627940 | 8A7FB59B81BC8173 | Owner-declared original brand/visual export; source-layer provenance not independently verified |
| public/intentchord-assets/intentchord-hero-dark-background.webp | 38824 | 051C79BCBACABED9 | Owner-declared original brand/visual export; source-layer provenance not independently verified |
| public/intentchord-assets/intentchord-hero-light-background.webp | 31872 | 5AB7C53776E27D30 | Owner-declared original brand/visual export; source-layer provenance not independently verified |
| public/intentchord-assets/intentchord-horizontal-color.png | 177354 | 0E08A480D0FD1835 | Owner-declared original brand/visual export; source-layer provenance not independently verified |
| public/intentchord-assets/intentchord-horizontal-color.svg | 236729 | F1C570F01F4CA226 | Owner-declared original brand/visual export; source-layer provenance not independently verified |
| public/intentchord-assets/intentchord-horizontal-color.webp | 109438 | BE55DE9487B56049 | Owner-declared original brand/visual export; source-layer provenance not independently verified |
| public/intentchord-assets/intentchord-icon-192x192.png | 35535 | 0ACC4C4FBF864348 | Owner-declared original brand/visual export; source-layer provenance not independently verified |
| public/intentchord-assets/intentchord-icon-512x512.png | 173105 | 79E901064BE518D4 | Owner-declared original brand/visual export; source-layer provenance not independently verified |
| public/intentchord-assets/intentchord-mark-color.png | 101717 | F81BEC23D2CC0F16 | Owner-declared original brand/visual export; source-layer provenance not independently verified |
| public/intentchord-assets/intentchord-mark-color.svg | 135854 | 3817E83E0FC85287 | Owner-declared original brand/visual export; source-layer provenance not independently verified |
| public/intentchord-assets/intentchord-mark-color.webp | 58952 | 8DBC0CA30BD1BD18 | Owner-declared original brand/visual export; source-layer provenance not independently verified |
| public/intentchord-assets/intentchord-vertical-navy.svg | 303379 | 5D7F37983638107D | Owner-declared original brand/visual export; source-layer provenance not independently verified |
| public/intentchord-assets/intentchord-vertical-white.svg | 192485 | FF84194F12645671 | Owner-declared original brand/visual export; source-layer provenance not independently verified |
 
**Source inspection:** five shipped SVG files contain inline data:image payloads; no external image href was found in those SVGs. Credential-shape followup found no high-confidence keys. Common PNG creator/GPS/comment EXIF fields returned no hits in examined PNGs. These tests do not prove originality or third-party image rights. WebP and ICO embedded metadata and attribution have not been fully assessed.

No separately bundled font files of extensions woff, woff2, ttf, otf or eot were found in Git tracked sources.

## External npm dependencies

The package-lock.json metadata contains **439 node_modules package entries** (including platform-specific and optional packages). Every entry has a declared license metadata value. Metadata is not a legal proof of compliance.

| Declared license expression | Entries |
| --- | ---: |
| MIT | 349 |
| Apache-2.0 | 33 |
| ISC | 15 |
| MPL-2.0 | 13 |
| LGPL-3.0-or-later | 10 |
| BSD-2-Clause | 7 |
| Apache-2.0 AND LGPL-3.0-or-later | 3 |
| BlueOak-1.0.0 | 2 |
| BSD-3-Clause | 2 |
| Apache-2.0 AND LGPL-3.0-or-later AND MIT | 1 |
| Python-2.0 | 1 |
| CC-BY-4.0 | 1 |
| CC0-1.0 | 1 |
| 0BSD | 1 |

Examples needing additional review if compiled or installed dependency files are redistributed: @img/sharp-libvips-* (LGPL), lightningcss* and axe-core (MPL), and caniuse-lite (CC-BY-4.0). The GitHub source snapshot excludes node_modules, third-party native package binaries and generated executables. Downloaded dependencies remain under their own licenses.

## Evidence limits and release gates

- Owner's original visual identity copyright claim: **RECORDED, not independently corroborated for every embedded asset**.
- External package declared license inventory: **RECORDED**, not full transitive obligations or legal review.
- Public source includes image exports and their embedded data; no proof that all underlying image layers have independently established origins.
- Prior to distributing binaries/installers, reassess the actual runtime/binary dependency set, notices, licenses, and source obligations.
- If any shipped image includes unlicensed third-party artwork, replace or remove it before making the repository public.
- This inventory does not certify the project as legally cleared or production ready.

See the Third-Party Notices and Brand Policy in the repository root.
