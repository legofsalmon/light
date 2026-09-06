# Generic fixture layouts

LIGHT's own GDTF sources, for fixtures whose channels are simply in order:
pars with a dimmer and a strobe in every common position, and bars and strips
of RGB / RGBW cells. Authored here, so LIGHT is free to ship them — GDTF Share
files are the operator's own downloads, under its terms, and never travel
with the app (docs/feature-backlog.md, decision 1).

`src-tauri/build.rs` compiles every `*.gdtf.xml` in this directory into the
app; on launch `src-tauri/src/library.rs` writes each one as a `.gdtf` into
the fixture library (`~/Library/Application Support/LIGHT/fixtures`) once per
`SEED_VERSION`, never overwriting a file that exists. The Rig view's Fixture
library lists them beside whatever was imported or fetched.

Authoring rules: `Manufacturer="Generic"`; one `DMXMode` per channel order,
named `<count>ch <order>`; cells of a bar are `Cell1..CellN` geometries so the
compiler makes a head per cell; amber (`ColorAdd_RY`) and UV (`ColorAdd_UV`)
are carried but held at zero — LIGHT mixes red, green, blue and white. A
change here needs `SEED_VERSION` bumped and the table in the library tests
updated; the tests compile every file and check its footprints and heads.
