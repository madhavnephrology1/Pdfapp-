# Known limitations

This document is deliberately blunt about what is implemented and tested versus
what is scaffolded or absent. Nothing below is described as working unless it
was built and exercised by a test.

Test counts as of this revision: **282** unit and integration tests in the web
app, **108** in the API, and **30** end-to-end tests in Chromium.

---

## Not implemented

These are absent, and there is **no control in the interface that pretends
otherwise**. Where the specification called for a feature that could not be
built honestly, the control was removed rather than left inert.

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

### Text recognition for scanned pages

The whole path works: the reader agrees to it in the interface, a page is
rendered to an image in the browser, sent to this app's API, recognised, and
returned with per-word confidence; uncertain words are marked and can be
retyped; the reader adds the page to the reading text, or does not.

What is honest to say about it, and what is not:

- **The Google Vision adapter has never run against the live service.** There is
  no credential in this repository and no network access in CI. Its tests pin it
  against the response shapes Google documents — request format, symbol
  assembly, skewed and zero-origin bounding boxes, missing confidence, per-image
  errors inside a 200 response, and every HTTP failure mapping. That is real
  coverage of the adapter's logic and no coverage at all of the assumption that
  Google's responses look like the documentation. Treat the first live call as
  untested.
- The **mock provider** is what the end-to-end tests use. It returns two
  obviously-fake `[unrecognized]` words at 40% confidence, deliberately: real
  text in a mock could mask a mistake in the marking or correction path.
- A recognised page is classified **with only that page in view**, because
  re-running the pipeline over the whole document would change every region and
  sentence id — moving the reader's place and discarding their include/exclude
  decisions. It is the same limitation as the first pass of incremental
  extraction and is marked the same way.
- Uncertain words are marked and corrected **in the recognition panel, before
  the page joins the reading text**. Once it has joined, the marking is at
  paragraph level ("read from an image of page N by _provider_, with N words
  still uncertain") rather than on the individual word. Marking individual words
  inside the flowing reader text would need a character-offset mapping from
  recognised word to normalised sentence that survives hyphen joins and
  line-wrap reconstruction, and that does not exist.
- Only **one page at a time** is recognised, by explicit request. There is no
  "recognise the whole document" action, deliberately: each page image is a
  separate disclosure and each costs the deployment money.
- Recognition results live in memory for the session. They are **not** written to
  IndexedDB, so reopening the document means recognising again.

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

|                                                 |                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| 1-page document, full pipeline                  | well under a second                                              |
| 50-page document, full pipeline                 | ~0.5 s in Node; a few seconds in the browser including render    |
| First rendered page                             | as soon as PDF.js opens the document, before extraction finishes |
| First readable text on the 50-page test fixture | 46 ms, against 155 ms for the whole document (Node)              |

**Extraction is incremental, and early passes are provisional.** The pipeline is
a pure function of the pages it is given, so the worker runs it over a growing
prefix — after page 1, then 2, 4, 8, 16 and so on — and sends each result to the
interface. Reading and playback become available at the first pass. Passes
double rather than running at a fixed interval, so the extra work stays below one
additional full pass however long the document is.

The catch is real and is stated in the interface rather than hidden: **a pass
over part of a document classifies with less evidence than a pass over all of
it.** A running header cannot be recognised as one until it has been seen on
several pages, so on the first pass it is read aloud. This errs in the safe
direction — an early pass reads _more_ than the final pass will, never less, so
no subject matter is dropped — but it means the skip decisions on screen can
change while analysis continues. While that is happening the app says so, and the
left panel names how many pages the current classification covers.

Consequences worth knowing:

- The reading position is carried across each pass by matching sentence text,
  because sentence ids encode a block index that can shift when a wider view of
  the document changes the estimated body font size. If the passage the reader
  was on has since been reclassified as furniture, playback resumes at the
  nearest following sentence rather than at the start of the document.
- A queue rebuilt while audio is playing is held until the next seam — a chunk
  boundary on a server voice, a sentence boundary on the browser's engine — or
  until playback pauses or stops. A new pass therefore never cuts off a sentence
  mid-word, but audio can lag the reader panel by up to one chunk: for that
  interval it may still speak a passage the panel already shows as skipped. It
  is verbatim source text either way. Resuming after a pause restarts the
  current sentence rather than the exact millisecond, because the chunk it sat in
  has been rebuilt.
- "Stop analysing" keeps what has been read so far instead of discarding the
  document. The left panel then goes on saying which pages were never examined.
- Whether audio actually starts before analysis finishes is a matter of timing,
  so it is covered by unit and integration tests rather than by an end-to-end
  test that would be flaky on fast machines. The end-to-end suite instead
  asserts that no provisional state is left behind once the final pass lands.

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
