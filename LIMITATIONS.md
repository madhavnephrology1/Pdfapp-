# Known limitations

This document is deliberately blunt about what is implemented and tested versus
what is scaffolded or absent. Nothing below is described as working unless it
was built and exercised by a test.

Test counts as of this revision: **354** unit and integration tests in the web
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

### Images, figures and flow charts

**Images are found and reported, never described.** Extraction walks the page's
drawing operations, tracks the transformation matrix through its save/restore
stack, and records the rectangle each painted image occupies. A marker — "Figure
on page 3 — not described" — is then shown in the reading text at the point the
figure falls, so a reader can tell "no figure here" from "a figure you were not
told about".

Three things it deliberately does not do. It does not look at what an image
contains: there is still no alt-text from the structure tree and no generated
description, because a description would be words that are not in the document.
It does not **speak** the marker, for the same reason — so **a listener who is
not looking at the screen still learns nothing about the figure**, which is the
real remaining gap. And it ignores anything smaller than 8% of the page's
shorter side, because rules, bullets and spacers are painted as images too.

Images that overlap are merged into one figure, since a chart is often painted
as many tiles and reporting eleven figures where a reader sees one would be
worse than reporting none.

Figure detection runs as a **second pass, after all the text**. `getOperatorList`
costs about what preparing to render costs — on a ten-page paper it nearly
tripled extraction, from roughly 0.5s to 2s — so doing it inside the text loop
would have delayed the first readable text and undone the incremental extraction
work. A page whose drawing operations cannot be read keeps its text and loses
only its figure markers.

Figure **captions** are detected and read, and are controlled by the "captions"
category in Custom Mode; that part works. So a figure is usually audible as its
caption and nothing else.

**The markers are announced in the audio**, under "Say where the pictures are"
in Settings, on by default. Before this they were on screen only, which meant
someone listening with the screen off could not tell a page with an
undescribed figure from a page with nothing to report — the exact gap the
markers exist to close.

These announcements are the **only** words this application puts into the audio
that the document does not contain. They are therefore:

- **switchable**, and turning them off changes nothing else — the document's own
  words are read in the same order either way, verified by test;
- **marked on screen** wherever they appear, so a reader can see which text is
  the application's and which is the document's;
- **carrying no provenance they do not have**: the queue entry has no source
  text item ids, no bounding boxes, and a zero-width span in the normalized
  text. Nothing downstream can mistake one for source text;
- **never the resume target.** Coming back to a document after a reload lands on
  the document's own words, never on an announcement;
- **silent on a page that is not being read.** A marker attached to a paragraph
  the current mode skips is not announced.

They say a picture is there and where. They say nothing about what it shows,
because this application does not read images.

**Flow charts and diagrams divide into two cases:**

- Drawn as a raster image, the labels are not in the text layer. The figure
  marker says it is there; its contents remain unavailable.
- Drawn as vector graphics with real text labels, the labels **are** in the text
  layer. They are extracted and read in geometric order — top to bottom, left to
  right — which for a branching diagram is not the order the diagram means, and
  a listener cannot hear that it is wrong. A vector diagram paints no image, so
  the figure marker does not cover it.

  This second case is now **detected but not interpreted**. The operator list is
  walked a second time for `constructPath`, and each path's own bounding box is
  carried through the transformation matrix in force, giving the areas of the
  page covered by vector drawing. An area is marked when the text inside it is
  mostly short runs — labels and cells rather than sentences.

  **What the marker claims is deliberately narrower than "a diagram".** The
  measure separates drawn areas from prose, but it does not separate a flow
  chart from a boxed "Key Points" summary: the text layer splits justified lines
  into one item per word, so the summary box scores as high on short runs as the
  chart does. Nothing measured here told them apart, so the marker says a drawn
  area is present and that its contents are read in page order — true of the
  chart, the table and the summary box alike — rather than asserting a diagram.

  Two shapes of drawn area are excluded as page furniture, both from measurement
  across five real papers: a path covering more than 70% of the sheet (background
  washes and page frames run 81–223% of page area, real drawings 9–58%), and a
  path spanning more than 90% of the page width (header strips, navigation bars
  and web-print footers run 93–105%, real drawings 42–86%). **A genuinely
  full-bleed diagram would therefore be missed**, which leaves a reader where
  they were before any of this existed rather than announcing something untrue.

  An area already covered by an image figure is not marked twice.

  Nothing here reads the diagram's structure, and nothing describes it. The
  labels are still read in page order; the marker only says so.

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

Handles single-column and the common two- and three-column layouts, **including
columns that very nearly touch**. Two independent signals are used, in order:

1. **The gutter.** Item coverage is projected across the page and an empty strip
   is looked for. This is the right test whenever there is a gutter to find.
2. **The line starts**, used only when the first finds nothing. In a real NEJM
   paper the gutter measures **2 points** at the density threshold — the columns
   almost meet — so no strip exists and thirteen two-column pages were read as
   one, interleaving the columns line by line into nonsense: "antineu- Me thods
   trophil cytoplasmic autoantibody–associated vas- Trial Design and Oversight
   culitis". The line starts are unambiguous even when the gutter is not: half
   the items begin at x=62 and half at x=269, and nothing begins between.

Line starts are a strict **fallback**, never an additional source. A first
attempt that let both propose boundaries turned two-column fixtures into
three-column ones, so a page that already splits on its gutter is now left
exactly as it was. Candidates from either signal face the identical checks —
side shares, crossing rows, band width — so this widens what can be proposed and
never what is accepted.

Table interiors are excluded from the column vote, so a table cannot be mistaken
for columns. Not handled: columns of unequal width that overlap vertically, text
flowing around a floated figure, and magazine-style layouts with more than three
columns. When detection is not confident the page is flagged as uncertain rather
than presented as certain.

### Letter-spaced text is read letter by letter

Some publishers set running heads with wide letter spacing, and PDF.js reports
the result with the spaces in it: the item's own string is literally
`"n e w e ng l a n d j o u r na l"`. Speech then reads it out letter by letter.

This is **not** repaired, deliberately. Removing spaces the extractor inserted
would mean deciding that "a b c" is really "abc", and that decision is wrong for
list markers, initials, and mathematics. Silently joining them would rewrite the
document, which is the one thing this reader must not do. The affected text is
almost always a running head, which is detected as repeated furniture and
skipped, so in practice it is rarely spoken — on the NEJM paper it survives once
in roughly 47,000 characters.

### Sentence ends around initials

Author lists write initials run together — "H.J.L. Heerspink", "D.C. Wheeler".
The rule that recognises an initial looked for a space before the letter, so on
a cluster it matched the FIRST period and not the last, and **the sentence ended
on the author's initials while the next one began on their surname**. On the
NEJM trial paper, 12 sentences ended that way, one of them consisting of nothing
but "H.J.L.". Both counts are now zero, and the document's sentence count fell
by exactly 12 — so every break removed was one of these, and no real sentence
end was lost.

A related case is **not** fixed: a sentence genuinely ending in a single capital
letter, as in "Patients received vitamin D. The dose was fixed." That single
letter is read as an initial, so the two sentences are joined. Telling them
apart needs to know whether the word after the period is a surname, and both
readings are capitalised. This predates the cluster rule and is unaffected by
it — the cluster rule requires two or more letter-period pairs precisely so it
does not widen the case. It is recorded here with a test that asserts the
current behaviour, so a future change to the single-letter rule starts from a
measured position.

Nothing is lost to either case. The segmenter only ever splits, never edits, so
every word is still read exactly as written; what a wrong boundary costs is the
pause, and the highlight moving at the wrong moment.

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

Two things about iOS are now known from a report sent back by a real iPhone
(iOS 18.7 / Safari 26.5), rather than assumed:

- **Safari does not expose downloaded Premium or Enhanced voices to web pages.**
  All 68 voices offered were the compact system set; a Premium voice installed
  and selected in iOS Settings did not appear at all. No selection logic here
  can choose a voice the browser never offers, and nothing in the interface
  claims otherwise.
- **Every voice is flagged as the system default.** `SpeechSynthesisVoice.default`
  was true for all 68, which makes it a constant and therefore no evidence. The
  ranking now ignores the flag entirely unless the platform marks _some_ voices
  and not others.

Selection also **never picks a novelty voice automatically** — Apple ships
nineteen of them (Bahh, Zarvox, Bad News…) with the same language tag and flags
as Samantha, and the API offers no way to tell them apart, so they are matched
by name. They remain in the picker and can still be chosen deliberately; the
picker groups them under their own heading rather than hiding them.

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

### Drop caps

A drop cap is one large letter whose baseline rests on the **last** line it
spans, while the letter belongs at the start of the **first**. Grouping lines by
baseline therefore grafted it onto the wrong line: the opening "T" of a real
paper landed two lines down and was read as "…of meta- Tbolic abnormalities",
which also broke the hyphen join that makes "metabolic". It is now attached to
the first line it spans.

A large letter only counts as a drop cap if it **displaces** text — its box has
to cover the baselines of at least two lines that are all indented past it. A
large initial that displaces nothing keeps its own line, as before.

A related fix came with it: a line's reported font size is now the median
**weighted by how much text each item carries**. Unweighted, a drop cap and its
line averaged to 18pt for a 10pt paragraph, which read as a font change and split
the block — taking the hyphen join with it.

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
size vertically, and it must be horizontally within the line's own span.

An item that attaches to nothing is grouped with its own neighbours exactly as
before. The first version of this isolated each one instead, which **broke
running-header detection**: a header set smaller than the body is entirely
"floating", so "Journal of Clinical Nephrology Vol. 12, No. 4" became two
lines, stopped matching as repeated furniture, and was read aloud on every page.
The unit tests did not catch it and the end-to-end suite did — it has a unit
test of its own now.

**Markers are now skipped in the audio, by position rather than by pattern.**
Line grouping records which items are raised, the pipeline converts those into
character ranges within each sentence (`SentenceRecord.markerSpans`), and the
speech projection skips those ranges. No pattern is matched against the text, so
nothing that merely resembles a marker is ever removed. On the reported PDF, 41
of 485 sentences carry markers; "treated.1,2" speaks as "treated."

Four things keep this from removing real content, each with a test:

- **Only raised items count.** A dropped one is a subscript — the 2 in H2O — and
  is reattached to its line but never marked as a citation.
- **The range must be a pure bibliographic pointer**: digits and separators
  only. A raised "1st", a dagger, or a letter is left alone.
- **The displayed sentence is never altered.** The marker stays on screen, drawn
  struck through, with "Not spoken: superscript citation marker" on hover. Only
  the spoken projection differs, and Strict Verbatim Mode speaks it too.
- **Word highlighting still lands correctly**, because the projection's offset
  map already handles skipped spans.

`skipSuperscriptMarkers` also still matches the literal Unicode superscript
characters (`¹²³`), which is the rarer form.

### Silence between sentences

The browser's speech engine fires utterances back to back with no gap, so a full
stop was inaudible and a heading ran straight into the paragraph below it —
reported as "doesn't indicate sentence ends". A pause is now inserted between
sentences, longer between paragraphs and after a heading, scaled down as the
reading speed goes up.

This is **timing only**: no word, sound or punctuation is added to what is
spoken. Every path that stops or redirects playback disarms the pending pause,
so pressing stop during a silence cannot be followed by the next sentence
starting anyway.

The **server-audio path is untouched**. There the gap between sentences is
whatever the provider rendered into the audio, and changing it would mean
editing that audio.

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
