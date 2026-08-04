# PDF Human Reader

Upload a PDF and listen to its meaningful text in a natural voice.

The reader skips repeated document furniture — running headers, footers, page
numbers, bibliographies — while speaking the author's own sentences word for
word. It never summarises, paraphrases, corrects grammar, completes a truncated
sentence, or invents text that is not in the document. Every spoken sentence is
traceable back to the exact region of the page it came from, and every automatic
exclusion is listed, explained, and reversible.

---

## Contents

- [System requirements](#system-requirements)
- [Local setup](#local-setup)
- [Environment setup](#environment-setup)
- [Development commands](#development-commands)
- [Testing commands](#testing-commands)
- [Docker](#docker)
- [Provider configuration](#provider-configuration)
- [How the reader decides what to read](#how-the-reader-decides-what-to-read)
- [Privacy behaviour](#privacy-behaviour)
- [Temporary-file behaviour](#temporary-file-behaviour)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)

---

## System requirements

|         |                                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------------------- |
| Node.js | 20.11 or newer (22 recommended)                                                                                         |
| npm     | 10 or newer                                                                                                             |
| Python  | 3.11 or newer                                                                                                           |
| Browser | A current Chromium, Firefox or Safari. The app uses the legacy PDF.js build, so browsers a version or two old work too. |

The API is optional. With no speech provider configured the app runs entirely in
the browser using its built-in speech engine, and says so in the interface.

---

## Local setup

```bash
git clone <this repository>
cd pdf-human-reader

# Frontend and shared packages
npm install

# Backend
cd apps/api
python3 -m venv .venv
./.venv/bin/pip install -e ".[dev]"
cd ../..

cp .env.example .env
```

Run both halves in separate terminals:

```bash
npm run dev       # web app on http://localhost:3000
npm run api:dev   # API on http://localhost:8000
```

Open <http://localhost:3000> and drop in a PDF.

To try the whole playback path with no API key, set `TTS_PROVIDER=mock` in
`.env` and restart the API. The mock provider generates silent audio with real
word timings, which exercises chunking, caching, prefetch and synchronisation
end to end.

---

## Environment setup

All configuration lives in `.env` at the repository root; `.env.example`
documents every variable. The essentials:

| Variable               | Purpose                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| `TTS_PROVIDER`         | `openai`, `elevenlabs`, `azure`, `mock`, or empty for browser-only speech |
| `TTS_API_KEY`          | Provider credential. **Server-side only** — never exposed to the browser  |
| `TTS_REGION`           | Required by the Azure adapter                                             |
| `OCR_PROVIDER`         | `google-vision`, `mock`, or empty to disable text recognition entirely    |
| `OCR_API_KEY`          | Provider credential. **Server-side only** — never exposed to the browser  |
| `MAX_UPLOAD_SIZE_MB`   | Server-side limit; mirror it in `NEXT_PUBLIC_MAX_UPLOAD_MB`               |
| `LOG_DOCUMENT_CONTENT` | Development aid. Forced off when `APP_ENV=production`                     |

Only `NEXT_PUBLIC_*` variables reach the browser. Never put a credential in one.

---

## Development commands

```bash
npm run dev            # Next.js dev server (copies PDF.js assets first)
npm run build          # production build
npm run start          # serve the production build
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint
npm run format         # Prettier write
npm run format:check   # Prettier check
npm run verify         # format:check + typecheck + tests

npm run api:dev        # uvicorn with reload
npm run fixtures       # regenerate the PDF test fixtures on disk
```

Inside `apps/api`:

```bash
./.venv/bin/ruff check app tests     # lint
./.venv/bin/ruff format app tests    # format
```

---

## Testing commands

```bash
npm run test               # unit + integration (282 tests)
npm run test:unit          # pure logic only
npm run test:integration   # full pipeline against generated PDF fixtures
npm run test:e2e           # Playwright, needs the app running on :3000
npm run api:test           # pytest (108 tests)
```

### What is covered

**Unit** — line grouping, paragraph reconstruction, hyphen handling, ligature
normalisation, duplicate text-layer removal, sentence segmentation and its
lossless invariant, TTS chunk boundaries, cache-key generation, reading-mode
inclusion rules, reading-queue construction and footnote ordering, header/footer
signatures, page-number patterns, reference classification, citation projection,
the playback state machine, and timing honesty.

**Integration** — the whole extraction pipeline run through PDF.js against
generated fixtures: a 1-page document, a 50-page document with repeated
furniture, a two-column paper with footnotes and a bibliography, a document with
a table and caption, an image-only page, a mixed scanned/digital document, and a
front-matter document with roman-numeral pagination; incremental extraction
over a growing page prefix; and merging a recognised page into a document.

**End-to-end** — upload and render, extraction, content review and restoring
exclusions, switching reading modes, starting and pausing playback, changing
speed without losing position, click-to-read, text-size and theme controls, page
and search navigation, resuming after a reload, keyboard accessibility, and the
text-recognition flow — consent gate, uncertain-word marking, correction, and
adding or removing a recognised page.

### Test fixtures

Every fixture PDF is **generated programmatically** by a small dependency-free
PDF writer in `packages/test-fixtures`. No third-party document is redistributed
in this repository. Run `npm run fixtures` to write them to disk for inspection.

---

## Docker

```bash
cp .env.example .env      # set TTS_PROVIDER and TTS_API_KEY if you have one
docker compose up --build
```

The web app is on <http://localhost:3000>, the API on <http://localhost:8000>.

Both images run as a non-root user. The API's temporary directory is a `tmpfs`
mount, so temporary files live in RAM and never reach a persistent volume. There
is no database and no volume: nothing derived from a user's document is
persisted server-side.

`NEXT_PUBLIC_API_BASE_URL` is compiled into the browser bundle, so change it as
a build argument, not at runtime:

```bash
NEXT_PUBLIC_API_BASE_URL=https://api.example.com docker compose up --build
```

---

## Provider configuration

Speech providers sit behind one interface and are selected entirely by
`TTS_PROVIDER`. No vendor name appears anywhere outside its own adapter module,
and adding a provider means adding one file in `apps/api/app/providers/tts/`.

| Provider     | Word timing | Speed            | Notes                                                         |
| ------------ | ----------- | ---------------- | ------------------------------------------------------------- |
| `openai`     | ✗ estimated | native, 0.25–4×  | Neural voices, audio only                                     |
| `elevenlabs` | ✓ **exact** | client-side rate | Character alignment folded into word boundaries               |
| `azure`      | ✗ estimated | native via SSML  | Word boundaries need the streaming SDK, not the REST endpoint |
| `mock`       | ✓ exact     | native           | Offline, silent audio, deterministic. For tests and demos     |
| _(empty)_    | ✓ exact     | native           | The browser's own engine, via `boundary` events               |

**Word-timing honesty.** When a provider returns real word boundaries, words are
highlighted exactly. When it does not, the position is derived from elapsed time,
the highlight is drawn differently (a dotted underline rather than a solid
block), the reader panel says "Estimated word position", and screen readers are
told the position is an estimate. Nothing in the code path can promote an
estimate to "exact".

---

## How the reader decides what to read

Extraction keeps **separate representations at every stage**, so no stage can
overwrite the source: raw PDF text items → technically normalized text →
classified layout regions → sentences → synthesis chunks → timing metadata, with
a transformation log and source coordinates throughout.

The only text changes the code can make are: joining a word split by a
line-ending hyphen, reconstructing paragraph line wraps, collapsing repeated
whitespace, expanding typographic ligatures, dropping zero-width characters, and
removing duplicated overlapping text-layer content. Each one is recorded as a
`TransformationRecord`. There is no spelling correction, no grammar correction
and no sentence completion anywhere in the codebase.

Classification is **conservative and evidence-based**. Each detector proposes a
region type with a confidence and a list of the signals that produced it:

- **≥ 80% confidence** — excluded in Clean Mode, listed in Content Review with
  its evidence, reversible in one click.
- **50–79%** — **included and read**, flagged for review. Uncertain subject
  matter is never silently discarded.
- **< 50%** — treated as body content and read.

Body paragraphs and headings can never be excluded automatically in Clean Mode,
at any confidence.

Three reading modes:

- **Clean Reading** (default) — body text, skipping only high-confidence running
  headers, footers, page numbers, watermarks and reference lists.
- **Strict Verbatim** — everything extractable, with only technical
  normalisation. Citation skipping and generated narration are all disabled.
- **Custom** — per-category switches for front matter, headers, footers, page
  numbers, footnotes, endnotes, captions, tables, citation markers, references,
  bibliography, index and sidebars.

Changing a setting rebuilds the reading queue from the same extraction data. It
never re-extracts and never destroys anything.

**Reading order** is reconstructed deterministically: duplicate text-layer items
are removed, columns are detected from a vertical projection profile (with table
interiors excluded from the vote, so a table cannot be mistaken for columns),
lines are grouped by baseline _within_ a column so columns never merge,
column-spanning headings act as band separators, and blocks are grouped by
vertical gap, font change and indentation. Where the result is not confident, the
page is flagged as uncertain in the navigation panel and in Content Review rather
than presented as certain.

**Tables** are their own regions and are skipped by default, because reading a
table as a stream of numbers is meaningless. You can switch them on, which reads
the cell text verbatim in row order with no added labels. Richer narration that
pairs each cell with its column heading is not implemented — see LIMITATIONS.md.

**Footnotes** can be skipped, read after each page, or read after each section.
Reordering moves whole footnote regions in the audio queue; the reader panel
still shows them where they sit on the page, and no sentence is ever edited.

**Citation markers.** The reader always _displays_ the author's full sentence.
When your settings ask for it, isolated bibliographic pointers such as `[12]` are
skipped in the **audio only** and shown struck through on screen. Parenthetical
prose citations such as "(Smith, 2019)" are read by default, because removing
them would change the sentence.

---

## Privacy behaviour

- **Your PDF stays in your browser.** Rendering, extraction, layout analysis and
  classification all run locally. The file is never uploaded.
- **The file is not stored** between sessions unless you opt in. By default only
  a fingerprint, your reading position and your display settings are kept, in
  this browser's IndexedDB.
- **Only the passage being spoken** is sent to a speech provider, and only
  through this app's own API, which holds the credential. Your browser never
  sees a provider key.
- **Page images are never sent for text recognition** without your explicit
  consent, given after being told which service receives them — and then only
  for the individual pages you ask for. The browser refuses to build the request
  without it and the API rejects any request that does not carry it.
- **No document content is logged** in production. Validation errors report
  field names only, so document text is never echoed back in an error message.
  A log filter redacts anything resembling a credential.
- **Nothing is used for model training** by this application. If you configure a
  third-party provider, its own terms govern the text you send it.
- Settings → _Delete everything this app has stored_ clears every reading
  position, setting and cached clip.

The in-app privacy notice is at `/privacy`, and the Settings panel names the
exact providers your deployment is configured to use, before you play anything.

---

## Temporary-file behaviour

Server-side temporary files are only created when a step genuinely needs one,
which today means OCR. They are:

- created with `O_EXCL` and owner-only permissions (`0600`) under a `0700`
  directory, with unguessable random names;
- deleted when the request finishes, whether it succeeded or raised;
- swept every 5 minutes for anything a crash left behind, using
  `TEMP_FILE_RETENTION_MINUTES`;
- purged entirely on shutdown.

Generated audio is cached **in memory only**, keyed by provider, voice, speed,
language and a hash of the exact text. It is evicted by age and by count, cleared
on shutdown, and never written to disk.

---

## Project structure

```
pdf-human-reader/
├── apps/
│   ├── web/                      Next.js App Router frontend
│   │   ├── app/                  routes, layout, global styles, privacy notice
│   │   ├── components/           panels, viewer, reader, player, review, settings
│   │   ├── features/
│   │   │   ├── extraction/       normalization, columns, lines, blocks, tables,
│   │   │   │                     sentences, pipeline
│   │   │   ├── classification/   repeated regions, page numbers, references,
│   │   │   │                     watermarks, front matter, citations, modes
│   │   │   ├── reader/           reading-queue construction
│   │   │   ├── playback/         chunking, state machine, timing
│   │   │   └── settings/         defaults and ranges
│   │   ├── workers/              extraction Web Worker and its message protocol
│   │   ├── lib/                  PDF.js setup, hashing, IndexedDB, API clients
│   │   ├── hooks/, stores/       keyboard shortcuts, theme; document + playback
│   │   └── tests/                unit, integration, e2e
│   └── api/                      FastAPI backend
│       └── app/
│           ├── api/              routes: health, tts, ocr
│           ├── core/             config, normalized errors, redacting logging
│           ├── models/           request/response schemas
│           ├── providers/tts/    base + openai, elevenlabs, azure, mock, registry
│           ├── providers/ocr/    base + google-vision, mock, registry
│           ├── services/         audio cache, temporary files
│           └── security/         upload validation, rate limiting
├── packages/
│   ├── shared-types/             the type contracts both halves share
│   └── test-fixtures/            dependency-free PDF writer + generated fixtures
├── docker/                       api and web Dockerfiles
├── scripts/                      PDF.js asset copy, fixture generation
├── .env.example
├── docker-compose.yml
├── LIMITATIONS.md
└── README.md
```

---

## Troubleshooting

**"This PDF could not be opened."**
The file is damaged, truncated, or uses an encryption method PDF.js cannot open.
Try re-downloading it, or open it in another viewer and save an unencrypted copy.

**"No readable text was found in this document."**
The pages are scans with no text layer, so there is nothing to extract and the
reader will not guess at words. If your deployment sets `OCR_PROVIDER`, open
_Text recognition_ from the navigation panel: it will offer to send an image of
a scanned page for recognition, once you agree to that. Recognised text is shown
to you with uncertain words marked before it becomes part of the reading text.

**No voices in the voice selector.**
Your browser has no speech voices installed (common in headless or minimal Linux
environments) and no server provider is configured. Set `TTS_PROVIDER=mock` to
verify the playback path, or configure a real provider.

**Playback does not start; the player shows an error.**
Browsers block audio until you interact with the page. Press play again. If the
error mentions the provider, check the API logs — provider errors are normalised
into plain language and never carry a stack trace.

**CORS errors in the browser console.**
`WEB_ORIGIN` must contain the exact origin serving the page. `localhost:3000` and
`127.0.0.1:3000` are different origins; the default lists both.

**The API says "not configured".**
`TTS_PROVIDER` is empty or its credential is missing. This is not fatal: the app
falls back to browser speech. Set `TTS_PROVIDER` and `TTS_API_KEY` to use a
server provider.

**Extraction is slow on a very large PDF.**
Extraction runs in a Web Worker, so the interface stays responsive, but a
thousand-page document takes time and holds two copies of the file in memory
(one for rendering, one for the worker). You do not have to wait for it: the
worker analyses a growing prefix and the reader becomes playable after the first
page. Until the last page has been seen the classification is provisional, and
the app says so — a running header cannot be recognised as one until it has
appeared on several pages, so it is read aloud at first. An early pass always
reads more than the final pass will, never less. See LIMITATIONS.md.

**Content Review shows something being skipped that should be read.**
Click _Read this_ on that region, or _Restore everything that was skipped_. Your
choice is remembered for that document and always beats the automatic rules.

---

## Known limitations

See [LIMITATIONS.md](./LIMITATIONS.md) for the full list, including what is
implemented and tested versus what is scaffolded.
