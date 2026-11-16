# Studio design system

Studio inherits the public site's editorial system instead of using a generic editor skin. Values below were read from the live site and its computed styles, not invented.

## Audit of the existing site

The stylesheet carries three stacked layers; only the last two are effective. `Source Sans 3` and `Barlow Condensed` are referenced but never loaded — anything that appeared to use them was a browser fallback, and Studio does not adopt them.

| Token | Value | Use |
| --- | --- | --- |
| Ink | `#090909` | Type on paper, stage field, block buttons |
| Paper | `#f2f0ea` | Workspace chrome, panel fields, clip blocks |
| Signal | `#ff4b0a` | Accent bands, playhead, active states, focus |
| Deep signal | `#b9320a` | Secondary emphasis on paper, error surfaces |
| Hairline | `rgba(9,9,9,.16)` | Internal dividers on paper |
| Stage | `#090909` | Preview field and timeline canvas |
| Radius | `0` | Every Studio control |
| Display | Anton 400, uppercase, `.86–1.02` leading | Titles, empty states, setup headline |
| Mono | IBM Plex Mono 9–11px, uppercase, `.06em` tracking | Labels, timecode, metadata, states |
| UI | Helvetica Neue / Arial 11–15px | Names, body copy, captions |

Motifs carried over: 2px rules on paper and 1px rules in dark chrome; numbered section labels with right-aligned meta; dashed empty states; 135° hazard stripes; 9–14px corner crop marks; IFB/planned-style right-aligned mono states; black block buttons that invert to signal orange; square status dots; arrow-led full-width links; orange focus ring at 2px offset 2.

## Translation by surface

- **Workspace shell.** Paper chrome, ink type, 2px structural rules, Anton project title, mono save state with a square dot. The stage and timeline stay ink-black so footage and cuts are judged accurately. Panels are numbered `01 / MEDIA` … `06 / RENDER QUEUE`.
- **Media browser.** Paper panel, dashed import field with signal `+`, ruled asset rows, mono metadata, `MISSING` tag plus `RELINK`, and the 2px signal left bar for the focused asset (the sidebar's active-item motif).
- **Preview monitor.** Ink field, 2px signal crop marks at the corners, mono format readout, outlined play disc, frame-stepped transport, mono timecode and absolute frame counter.
- **Inspector.** Paper panel with 2px section rules, mono field labels, bordered steppers with frame units, ruled readouts, caption rows with mono timecode and a signal accent on destructive actions.
- **Timeline.** Ink canvas under a 4px signal band; mono ruler ticks aligned to the `V1` label column; paper clip blocks with ink borders; selected clips filled signal orange with an inset ink rule; black trim handles; 2px signal playhead with a square cap; dashed empty lane.
- **Stream-to-ZIP.** Index rows (`number / file / kind + size / state`) under the same 2px rules, segmented scope control, orange state dots, 4px signal progress bar on a hairline track, and a black block CTA with an arrow.
- **Render queue.** The site's numbered workflow-index row at working scale: job number, uppercase title, mono description, right-aligned state, row-level actions, and a black block CTA. Empty and failed states use the same grammar rather than a toast.

## Deliberate additions

One derived token, `--ed-rule` (`rgba(9,9,9,.16)`), is needed because the marketing pages separate blocks with 2px rules and never need a hairline inside a dense panel. Structural separations still use 2px ink.

The editorial system is applied through `src/editor/editor.css`, scoped to `.editor`, `.ed-setup`, `.ed-message` and `.ed-legacy-header` so the public site and workspace keep their own cascade.
