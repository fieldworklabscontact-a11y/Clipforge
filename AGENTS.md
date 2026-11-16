# ClipForge design rules

Adapted from [signs-of-ai-design](https://github.com/febbhav/signs-of-ai-design) (`design-rules.md`, CC BY-SA 4.0). This project follows it as a bias corrector: every item below is a legitimate choice in the right context, so the rule is "make it a decision, not a default".

## Core principle

Unspecified choices default to the statistical median of training data, which is the AI look. Before shipping UI, assume the first instinct for color, type and layout is that median, and make at least one deliberate departure.

## Decisions this project has made on purpose

- **Color:** near-black editing-suite surface (`#0d0e0f`) with a single signal-orange accent (`#ff4a12`) for actions and live state. No cream/amber palette, no purple or indigo gradients, no emerald fallback, no neon glow shadows, no gradient text. Orange is the brand's recording-light reference, not a hue picked because purple was banned.
- **Type:** three families with fixed jobs — Anton for the poster wordmark and the hero line only, Archivo for every heading, label and paragraph, IBM Plex Mono only for timecodes and durations inside Studio. Mono is never a decorative label font. Headings are sentence case everywhere except the hero and wordmark.
- **Layout:** asymmetric hero, sections sized by their content. No three-card feature row, no bento grid, no logo wall, no invented stats or testimonials. Numbers appear only where a sequence is real (the four production stages).
- **No section rubrics:** no repeated "01 / THE REASON" bars, eyebrow chips, or kickers above sections. Headings carry the section.
- **Surfaces:** panels are square and hairline-bordered with no shadow; only buttons and inputs take a 3px radius, tags are pills. No glassmorphism, no left accent strips on ordinary cards.
- **Icons:** none on buttons, no arrow on every CTA, no emoji. Functional icons only where they name an action (upload, play), and none for concepts.
- **Motion:** no fade-up-on-scroll, no bounce or elastic easing. Only state transitions on controls.
- **Copy:** name what the product does. No weightless headline, no buzzword layer (streamline, supercharge, seamless, robust, unlock), no "it's not just X, it's Y", no aphorism closing every section, em dashes kept rare.

## Rules to keep applying

- Color: no indigo/violet gradients; no cream or emerald fallback; no neon-on-black glow; one dominant color plus one real accent; no gradient headings or numbers.
- Typography: do not ship Inter/Geist/Space Grotesk by default; no oversized italic serif hero; build a real type scale; do not crush display tracking or set body copy in mono.
- Layout: vary spacing for rhythm instead of one padding value; let content decide card counts; cut or reorder the standard hero/logo wall/three cards/testimonials/stats/pricing/FAQ waterfall.
- Components: vary radius by element; override library defaults instead of shipping them; commit to one edge treatment (no hairline border plus wide diffuse shadow).
- Imagery: no fake terminal chrome with traffic-light dots unless it is a developer tool showing real output; no AI-image giveaways.
- Trust: never invent user counts, clients or testimonials. Leave trust content out until it is real.

## The one rule

No single item matters alone. The AI look is the co-occurrence of many defaults with no deliberate choice anywhere. Ship a design where the important decisions were made on purpose.

## Poster layer (from the three orange/ink references supplied 2026-11-16)

- Three colours only: paper `#f2efe6`, ink `#12100e`, signal orange `#ff4a12`. Orange is an accent, never the page field — a full orange page is too intense to read. Large orange areas are limited to the hero frame, the closing band and the final CTA; elsewhere orange appears as a small block, a mark or the wordmark dot.
- Type roles: Anton = wordmark; Archivo Black = display headlines; Archivo = body and labels; IBM Plex Mono = timecodes only.
- Display headlines are uppercase, tracking -0.05em, and each line sits above a 1px ink rule; the block runs the full 1216px rail.
- Meta is parenthetical, not chipped: `(AVAILABLE NOW)`, `©2026`. No eyebrow pills, no numbered section rubrics, no arrows on every CTA.
- Rules carry the structure: 1.5-2px ink hairlines, index rows and ruled tables. No cards, no soft shadows; the one offset block is behind the tilted hero frame.
- Exactly one tilted element (hero frame, -2.2deg). Nothing else rotates.
- Grain is SVG turbulence at 32% multiply, painted behind the type, on the hero, statement, closing and footer only.
- Slab rhythm: paper -> ink (live demo) -> paper -> ink (templates) -> orange (closing, the one loud band) -> ink footer with the oversized wordmark and the year set in orange.
- The workspace never inherits these tokens: the poster surface is scoped to `.poster-surface[data-surface=poster]`, so `/app`, `/studio` and the editor keep their neutral themes.
