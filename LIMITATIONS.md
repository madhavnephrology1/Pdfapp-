# Known limitations

This document is deliberately blunt about what is implemented and tested versus
what is scaffolded or absent. Nothing below is described as working unless it
was built and exercised by a test.

Test counts as of this revision: **316** unit and integration tests in the web
app, **108** in the API, and **31** end-to-end tests in Chromium.

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

### The GitHub Pages build is a reduced build

`.github/workflows/pages.yml` publishes the web app as static files. It is
genuinely useful — the whole extraction and reading pipeline runs in the
browser, and it gives a link that opens on a phone — but three things are worse
than the server build, and the interface does not pretend otherwise:

- **No API, so no natural voices.** Speech falls back to the browser's own
  engine. The reader panel names the engine in use.
- **No text recognition.** Scanned pages stay unreadable.
- **Weaker headers.** A static host sends none, so the Content-Security-Policy
  moves into a `<meta>` tag. `frame-ancestors` is ignored in a meta policy, and
  `X-Frame-Options` and `X-Content-Type-Options` cannot be expressed there at
  all. The Next server build and the Docker image still set all of them.

The static export is verified: it is built and served from a subdirectory, as a
project page is, and exercised at both phone and desktop widths — upload,
extraction, reading text, and PDF rendering, with no failed requests. What has
**not** been exercised is GitHub Pages itself, since this environment cannot
reach it.

### On a phone, the PDF page view is hidden

Below 1180px the middle column — the rendered PDF — is removed, leaving the
reading text. That is deliberate: at phone width three columns are unusable, and
the reading text is the point. But it means the "see the source region on the
page" affordance is desktop-only, and sentence-to-page traceability on a phone
is reduced to the page number in the player bar.

### The interface type has two weights, not three

Outfit is vendored in `apps/web/app/fonts` at 400 and 700 only — the weights
available to embed. `font-synthesis-weight: none` is set on `body` so a stray
`font-weight: 600` falls back to a real 400 instead of a browser-smeared fake
bold; every declaration in the app was normalised to 400 or 700 when the style
sheets landed. If a middle weight is ever wanted, it has to be a real file.

The **reading text is still a serif** (Georgia and its fallbacks), deliberately:
the style sheets specify the geometric sans for interface, and a document read
end to end for comprehension is not interface.

### Contrast is enforced against every ground, and only for colour

Every token in `globals.css` was checked against `--bg`, `--surface` and
`--surface-2` in all three themes, and the rendered page was then re-checked
element by element in a real browser — every text node sampled against its
effective background, at its own size and weight. Nothing renders below WCAG 2.2
AA in light, dark or sepia.

Two colours therefore differ from the published style sheets: the rose moved
from `#E11D62` to `#C81454` (3.88:1 on a raised surface), and the dark accent's
button fill from `#3B6FFF` to `#3465F0` (white on it reached only 4.28:1). The
sheets were updated to match, so the specimen and the product carry the same
hexes.

What this does **not** cover: contrast of text drawn over the rendered PDF page
itself, which is whatever the document's own colours are; and non-colour
accessibility — focus order, target size, motion — which is unchanged from
before and was never measured.

### Which voice speaks by default

The default is chosen by ranking evidence, strongest first: a voice the reader
picked before (now remembered in localStorage — it was not remembered at all
previously, so every reload silently reset it), then the server's configured
voice when a speech provider is set up, then **the voice the operating system
itself reports as the user's default**, then an on-device voice in the page's
language, then whatever came first.

The system-default signal is `SpeechSynthesisVoice.default`, reported by the
platform. What is **not** verified: whether iOS Safari exposes a downloaded
Premium or Enhanced voice as a separate entry, exposes it under the plain name,
or marks it default at all. There is no WebKit build in this environment to
check, and the behaviour differs between platforms. If the automatic choice is
wrong the dropdown still overrides it, and that choice now persists.

The voice list is also **re-read whenever the platform changes it**, not only at
mount. Reading once was wrong on iOS, which populates the list asynchronously
and changes it again when a download finishes or the system voice is switched
while the page is open — a voice added after load was simply never seen.

Settings carries a **voice report** for the same reason the reader panel carries
an extraction one: the device where this goes wrong is a phone with no console.
It lists every voice the platform offered with the flags it reported, and says
which one is speaking.

"Premium" and "Enhanced" in a voice name set the `neural` flag, which is a
**name heuristic** — the Web Speech API reports no quality field. It only
affects ranking; nothing in the interface claims a voice is high quality.

### Superscript citation markers are shown, and still spoken

A superscript is set smaller than the body and lifted above its baseline, so
grouping lines by baseline alone gave it a line of its own. When it landed
between two body lines it became its own **paragraph**, cutting a sentence into
three on screen: "…such as small cell" / "3-5" / "carcinoma, breast cancer…".
Line grouping now reattaches an item that is materially smaller than a
neighbouring line and sits within a superscript's rise or a subscript's drop of
that line's baseline, at its own horizontal position. On one real journal PDF
this took the page count of paragraphs from 165 to 60 and sentences from 486 to
328 — all of them fragments that had been split off markers.

Three guards keep it from over-merging, and each has a test: the item must be
smaller than the line it joins (so a uniformly small footnote or caption block
has nothing floating in it), it must sit within a fraction of that line's font
size vertically, and it must be horizontally within the line's own span. A
marker with no line to belong to keeps its own line rather than being dropped.

**What still is not done:** the marker is read aloud. `skipSuperscriptMarkers`
exists as a setting but its detector only matches Unicode superscript
characters (`¹²³`), and a typographic superscript is ordinary digits made small
and raised — so the setting never fires on the common case. Skipping them
properly needs the offset of each superscript run inside the sentence;
`SentenceRecord` carries `sourceTextItemIds` but not per-character spans, so
that mapping does not exist yet. It was **not** approximated with a text pattern
on purpose: a rule like "digits glued to the previous word" also matches `H2O`
and would silently drop real content, which is exactly what this application
must never do.

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

PDF.js's own worker module is **bundled into the extraction worker** rather than
left to be fetched. Its fallback path fetches the same file the nested worker
just failed to start from, so one unfetchable file used to take both paths down
and every page then failed. Evaluating the module registers the handler PDF.js
looks for before it fetches anything. This is verified in both directions:
deleting the emitted `pdf.worker.*.mjs` from the served directory leaves the
document reading normally, and removing the import as well makes it fail to open
at all.

### Safari cannot run PDF.js's own `getTextContent()`

`PDFPageProxy.getTextContent()` reads its result with `for await (const value of
readableStream)`. That needs `ReadableStream.prototype[Symbol.asyncIterator]`,
which **Safari does not implement**. Every call therefore throws `undefined is
not a function` before a single text item is read.

This was not theoretical. On iOS 18.7 / Safari 26.5 all fifteen pages of a
document failed with that message, while the same file read normally in
Chromium — reported from the phone by the diagnostic panel described below.
`readTextContent` in `lib/pdf.ts` reads the same stream through
`getReader()` and assembles the result the way PDF.js does, so extraction no
longer depends on that platform feature. The extraction worker and the test
helper both use it, so the tested path and the shipped path cannot drift apart.

**Still unconfirmed on the device.** The fix is verified by unit tests against a
stream that deliberately has no async iterator, and by the integration suite
extracting real fixtures through it, but no WebKit build is available in this
environment and the network policy blocks reaching the deployed site. Whether
anything _else_ also fails on iOS is unknown.

End-to-end tests run in Chromium only. **Firefox and Safari remain untested**
here. The failure states in the reader panel carry a diagnostic report — page
counts, distinct per-page failure reasons, the last worker message and the
browser string, and no document text — so a phone can say what happened without
a developer console. That report is what identified the bug above.
