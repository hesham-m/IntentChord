# IntentChord — Third-Party Licenses and Notices

The [PolyForm Noncommercial 1.0.0 license](LICENSE) applies only to source that its licensor is entitled to license. It does not override licenses governing third-party components.

## Dependency context

The source declares external npm dependencies in package.json and package-lock.json. Some direct packages locked in the source dependency graph include:

| Package | Locked version in upload-ready candidate | Declared license |
| --- | --- | --- |
| Next.js | 15.5.28 | MIT |
| React | 19.1.2 | MIT |
| React DOM | 19.1.2 | MIT |
| pg | 8.22.0 | MIT |
| Zod | 4.6.7 | MIT |
| minimatch (development tool, transitive) | 11.0.1 | BlueOak-1.0.0 |

These packages and their transitive dependencies are normally downloaded when a developer installs them using npm. **node_modules is not part of the intended GitHub source upload.** A source-only repository is not the same as redistributing every installed dependency or binary bundle.

Any third-party source, vendored component, image, font or other asset **actually copied into a published repository or distribution** must be used according to its own terms, including notices and attribution where required. Distribution of a built binary/package can create additional obligations beyond source-only publication.

A preliminary local package-manifest scan does not constitute a complete legal inventory or prove that all bundled assets have been cleared. The original IntentChord brand is governed separately by [BRAND_POLICY.md](BRAND_POLICY.md); this does not assert ownership of independent third-party marks.
## Public-source inventory and verification boundary

See the [Public Asset and Dependency Rights Inventory](docs/PUBLIC_ASSET_AND_DEPENDENCY_RIGHTS_INVENTORY.md) for exact shipped visual asset identifiers and the 439 locked external package nodes grouped by declared license. The source-only repository does not ship node_modules or compiled third-party bundles.

The original project identity and imagery are claimed by the Owner; underlying design-layer provenance is not independently proven. Lockfile license strings are inventory metadata, not legal clearance. External dependencies under LGPL, MPL, CC-BY and other licenses remain independently governed and may impose additional obligations if their actual binaries or contents are distributed.