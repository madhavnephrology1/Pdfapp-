# Known limitations

This document is deliberately blunt about what is implemented and tested versus
what is scaffolded or absent. Nothing below is described as working unless it
was built and exercised by a test.

Test counts as of this revision: **210** unit and integration tests in the web
app, **88** in the API, and **22** end-to-end tests in Chromium.

---

## Not implemented

These are absent, and there is **no control in the interface that pretends
otherwise**. Where the specification called for a feature that could not be
built honestly, the control was removed rather than left inert.

### Optical character recognition

The interface, consent gate, confidence handling, low-confidence marking, error
normalisation and HTTP route are complete and tested. **Only a mock provider
ships** — no real vendor adapter exists, and there is no browser-side flow that
renders a page to an image and calls the endpoint.

Consequence: scanned pages are reported as having no readable text. Nothing is
guessed. The Settings panel says this plainly instead of offering a switch.

Adding a real provider means writing one adapter in
`apps/api/app/providers/ocr/` and a client flow that renders the page, asks for
consent, and posts the image.

### Equations

There is no equation detection. Accordingly there is no equations setting. The
"skip / read literally / accessible narration" choice from the specification is
not present, because none of those three behaviours exists.

Consequence: equations laid out as ordinary text items are read as whatever
their text layer contains, which for many PDFs is a jumble of glyph names. This
is honest but not good, and it is the largest gap in reading quality.

### Image alt text and generated descriptions

No alt-text extraction from the PDF structure tree, and no generated
descriptions. Both settings were removed. Figure **captions** are detected and
are controlled by the "captions" category in Custom Mode; that part works.

### Structured table narration

Tables are detected as their own regions and skipped by default, which is the
important behaviour. The setting offers "read the cells in row order", which
reproduces cell text verbatim, row by row, with no added labels.

The richer narration from the specification — pairing each cell with its column
heading and announcing "Row 2" — is **not implemented**. It would insert
generated words into the audio, which needs a display representation to match,
and that was out of scope for this release.

### Manual region reordering

Pages whose reading order is uncertain are flagged in the navigation panel and
in Content Review, and their evidence explains why. The user **cannot drag
regions into a different order**; they can only include or exclude them.

### Right-to-left and vertical scripts

Item direction is captured and lines are ordered right-to-left when items report
`rtl`, but this is **untested** — no RTL fixture exists. Vertical (`ttb`) text is
captured but never specially handled.

---

## Implemented with caveats

### Word-timing accuracy

Only ElevenLabs (character alignment folded into word boundaries), the browser's
own engine (`boundary` events), and the mock provider give exact word positions.
OpenAI and Azure return audio without boundaries, so word position is derived
from elapsed time.

An estimated position is drawn differently (a dotted underline rather than a
solid highlight), stated in the reader panel, and announced to screen readers as
estimated. There is no code path that reports an estimate as exact.

### Sentence timing within a chunk

No provider currently returns per-sentence timings, so the sentence boundary
inside a multi-sentence chunk is derived from each sentence's share of the
chunk's characters. This is accurate enough to keep the highlight in the right
sentence but can drift on chunks that mix very short and very long sentences.
Seeking to a sentence uses the same estimate.

### Speed changes

Server audio is resampled in place by the audio element, so the playhead does
not move. The browser engine cannot change rate mid-utterance, so a speed change
**restarts the current sentence** — not the document. That is a real
interruption, and it is the best available behaviour for that engine.

### Rate limiting is per process

`RATE_LIMIT_TTS_PER_MINUTE` and `RATE_LIMIT_OCR_PER_MINUTE` use an in-process
fixed-window counter. Behind a load balancer with several API instances, the
effective limit is the configured value **times the number of instances**. Use
an edge rate limiter for a real deployment.

### Memory: the file is held twice

The UI thread keeps the PDF bytes for rendering and sends a **copy** to the
extraction worker. A 100 MB PDF therefore occupies roughly 200 MB during
extraction. The worker's copy is released when extraction finishes. This is the
main constraint on the practical document size, and it is why
`MAX_UPLOAD_SIZE_MB` defaults to 100.

There is no artificial page-count limit anywhere in the application logic.

### Column detection

Handles single-column and the common two- and three-column layouts. Table
interiors are excluded from the column vote, so a table cannot be mistaken for
columns. Not handled: columns of unequal width that overlap vertically, text
flowing around a floated figure, and magazine-style layouts with more than three
columns. When detection is not confident the page is flagged as uncertain rather
than presented as certain.

### Front matter

Detected from roman-numeral pagination and conventional headings, and annotated
as evidence. The **"front-matter" Custom Mode category does not yet exclude it**,
because front matter is not a `RegionType` — the annotation is advisory only.
Clean Mode reads front matter, which is the intended default.

### Endnotes

`endnote` exists as a region type and as a Custom Mode category, but no detector
assigns it. Endnotes at the end of a document are usually classified as
`reference` or `paragraph` instead.

### Audio cache is per process and in memory

Cached audio does not survive an API restart and is not shared between
instances. This is deliberate — it is derived from a user's private document —
but it means a restart re-synthesizes, at cost.

### Fixture realism

All test fixtures are generated by the small PDF writer in
`packages/test-fixtures`, using base-14 fonts. They cover the structural cases
the pipeline cares about, but they do **not** exercise embedded font
subsetting, unusual encodings, tagged-PDF structure, or producer-specific
quirks. Real-world PDFs are messier than any fixture here.

### `getTextContent` and marked content

Extraction consumes text items only; `includeMarkedContent` is not enabled, so
the PDF's own structure tree (which some tagged PDFs use to express real reading
order) is ignored in favour of geometric analysis. For a well-tagged PDF the
structure tree would be more reliable.

---

## Security notes

- The upload-size check in the browser is a courtesy check. The **API** enforces
  `MAX_UPLOAD_SIZE_MB` on anything actually sent to it.
- `validate_pdf_signature` and `sanitize_filename` are implemented and tested but
  are only reachable from the OCR path today, because nothing else uploads a
  file. They are ready for when one does.
- The Content-Security-Policy allows `'unsafe-inline'` for styles, which CSS
  Modules and Next's inlined styles require, and for scripts, which Next's
  bootstrap requires. `'unsafe-eval'` is allowed **only** in development.
- `npm` `overrides` pin `postcss` and `sharp` above the versions Next depends on,
  because Next's pinned versions carry known high-severity advisories. Re-check
  these when upgrading Next; `npm audit` currently reports zero vulnerabilities.

---

## Performance

Measured informally on the generated fixtures, in this container:

|                                 |                                                                  |
| ------------------------------- | ---------------------------------------------------------------- |
| 1-page document, full pipeline  | well under a second                                              |
| 50-page document, full pipeline | ~0.5 s in Node; a few seconds in the browser including render    |
| First rendered page             | as soon as PDF.js opens the document, before extraction finishes |
| First playable audio            | after extraction completes                                       |

**Extraction is not incremental.** Classification needs document-wide context —
which strings repeat across pages, the body font size — so the reading text
appears only when every page has been extracted. The PDF viewer is usable
immediately, and per-page progress is reported throughout, but the first
_playable_ audio waits for the whole document. On a very large PDF that wait is
noticeable. Making the first pages readable before the rest are classified is the
clearest next improvement.

The following are **not** measured, despite being listed as goals: filter
precision against human-labelled ground truth, OCR confidence distribution,
audio-generation failure rates in production, and peak memory under load. There
is no telemetry in this release.

---

## Browser support

The app uses the **legacy** PDF.js build, so it runs on browsers a version or
two behind current. The modern build assumes JavaScript builtins that even
recent Chromium releases lack, and fails at runtime on them.

The extraction worker asks PDF.js for its own nested worker. Browsers that
support nested workers give PDF.js a separate thread; those that do not fall
back to running it on the extraction worker's thread — still off the UI thread,
which is what matters for responsiveness.

End-to-end tests run in Chromium only. Firefox and Safari are untested.
