# Agent Note: Single self-contained brand mark

Status: implemented

English | [中文](2026-10-08-single-self-contained-brand-mark.zh.md)

## Problem

The interface brand was two hand-authored SVGs: `FishLogo` drew a mark and `BrandWordmark` drew letterforms plus a badge plate, both in `currentColor`, so a host could recolor either one and the expanded sidebar composed them as a mark beside an independent name.

The replacement identity arrives as a traced vector lockup — a blue mark above a `Vreal` wordmark. The mark alone ships as `logo-mark.svg`, and it carries its own ink and no letterforms. Rendering the lockup in both brand slots would show it twice in the expanded sidebar, the `currentColor` recoloring the SVG pair supported would silently do nothing, and the wordmark band is a few pixels tall at the slots' 24 px and 34 px.

## Decision

`FishLogo` renders `/logo-mark.svg` as an `<img>` whose rendered width is its `size` prop; the height follows the mark's intrinsic ratio. The mark renders an empty `alt`, so assistive technology skips it exactly as it skipped the `aria-hidden` svg it replaced.

`BrandWordmark` and the exported `BrandWordmarkProps` are gone, and with them the `includeMark` option, which chose whether the old artwork showed its leading mark.

`OfficialBrandName`, the `sidebar.brand.name` occupant in `@vreal/dsh-client-ui-brand-official`, renders nothing: the mark holds the whole identity, and keeping an occupant registered is what suppresses the shell's `DSH Local Build` fallback label in official builds; every other build profile keeps the shell's own fallback for that slot.

The web app ships that same file as its tab and install icon, replacing the previous scheme-switching favicon, so one file serves the mark slots and both icon references.

## Testing

Keyless unit tests pin the mark's path, the requested width, the decorative `alt`, and the empty name occupant ([icons spec](../../../../packages/client/ui-primitives/tests/icons.client.spec.tsx), [brand occupancy spec](../../../../packages/client/ui-brand-official/tests/browser-plugin.client.spec.tsx)). The expanded and collapsed sidebar renders are pinned by [the sidebar snapshot](../../../../packages/client/ui-sidebar/tests/__snapshots__/sidebar-snapshot.client.spec.tsx.snap), which asserts the `<img>` element in the mark slot. [The install-metadata suite](../../../../apps/web/tests/pwa-manifest.e2e.ts) reads the built output and pins both icon references plus the ink the mark file carries.

## Deferred

The `Vreal` wordmark of the supplied lockup reaches no surface: the brand slots render the mark alone, so that half of the artwork is unused. The documentation site keeps identity assets of its own — an inlined wordmark and a favicon — both still drawn from the previous identity ([documentation-site note](../process/2026-08-12-documentation-site-navigation-and-chrome.md)).

## Alternatives considered

**Ship the whole traced lockup to the mark slots.** Rejected: the wordmark band occupies 16 of the file's 124 canvas units, so at the slots' 24 px and 34 px it draws a few pixels tall.

**Render the product name as text in the name slot.** Rejected: it adds user-visible copy that no design source supplies, while the shell already renders a text fallback for builds with no official occupant.

**Keep `includeMark` as an accepted no-op.** Rejected: no consumer outside this repository exists, and a parameter that silently ignores its argument is a compatibility shim rather than a contract.

**Keep the hand-authored SVGs and recolor them for the new identity.** Rejected: the supplied artwork is the identity, and redrawing its geometry would substitute a hand approximation for the brand owner's own drawing.

## Consequences

- The mark cannot ride the theme's ink: its traced fills are fixed blues, which read on both color schemes. The web icon's per-scheme fill swap goes with them.
- The mark's curves are traced from raster artwork, so they approximate the supplied geometry; a vector export from the brand owner replaces the file without touching this composition.
- The component name `FishLogo` and the `.fish*` class names stay even though the drawn glyph is no longer a fish, and [the rebrand codemod](../../../../scripts/rebrand.ts) still names `FishLogo.tsx` as the artwork file to replace.
