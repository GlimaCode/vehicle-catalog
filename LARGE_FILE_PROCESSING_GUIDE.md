# Large file processing guide

## Measured performance

On the development machine (Windows 11, Node 24, local SQLite):

Measured on the real requirement, not a scaled-down proxy. Every stage ran to
completion for both fixtures. Source of record:
`exports/Large_File_Performance_Report.json` and `.csv`.

| Measurement | Fixture A | Fixture B |
|---|---|---|
| Shape | 100,000 rows × 100 columns | 250,000 rows × 20 columns |
| Input file size | 172.8 MB | 43.2 MB |
| Parse duration | 18.5 s | 5.9 s |
| Processing duration | 77.3 s | 40.6 s |
| CSV export duration | 21.3 s | 7.2 s |
| XLSX export duration | 114.7 s | 92.3 s |
| Change-report duration | 60.8 s | 141.7 s |
| **Total duration** | **292.7 s** (4 m 53 s) | **287.7 s** (4 m 48 s) |
| **Peak RSS** | **1,130.4 MB** | **929.9 MB** |
| **Peak JavaScript heap** | **122.9 MB** | **125.9 MB** |
| Temporary-storage peak | 1,314.9 MB | 1,358.1 MB |
| Database growth | 539.1 MB | 527.7 MB |
| CSV output | 201.0 MB | 114.4 MB |
| XLSX output | 70.8 MB | 48.9 MB |
| Change report | 22.1 MB | 56.4 MB |
| Total output | 294.0 MB | 219.7 MB |
| Rows requiring review | 100,000 | 250,000 |
| Changed fields | 50,000 | 125,000 |
| **Result** | **PASS** | **PASS** |

Peak RSS is reset between fixtures, so each row is that fixture's own high-water
mark rather than a shared process maximum.

The heap stays near 125 MB in both cases regardless of file size — that is the
streaming design working. RSS is much larger than the heap because SQLite's page
cache and the XLSX writer's buffers live outside the JavaScript heap.

| Smaller reference points | Rows | Time | Peak heap |
|---|---|---|---|
| `samples/large_fixture.csv` | 100,000 × 5 | ~14 s | ~102 MB |
| Sample listing file | 10 | < 0.1 s | negligible |

## Recommended hardware

Derived from the measurements above, not from guesswork.

| Resource | Recommendation |
|---|---|
| Minimum RAM | **4 GB** — enough for a single 100,000-row job with ~1.2 GB peak RSS plus the OS. Do not run other memory-heavy applications at the same time. |
| Recommended RAM | **8 GB or more** — comfortable headroom for a large job alongside a browser and normal desktop use. **16 GB** if you intend to process several large projects concurrently (`processing.maxConcurrentProjects` defaults to 4). |
| Recommended free disk space | **5 GB** for large-file work. A single Fixture A run consumed ~1.3 GB of temporary storage, grew the database by ~539 MB and produced ~294 MB of output. Add the 16 MB release database and room for backups. |
| CPU | Any modern x64 CPU. The work is single-threaded and I/O-bound; more cores help only when processing several projects at once. |
| Disk type | SSD strongly preferred — every stage is I/O-bound. |

### Expected processing characteristics

- **Throughput is driven by cell count, not row count.** Fixture A (10 million
  cells) and Fixture B (5 million cells) took almost the same total time, because
  A has fewer but much wider rows.
- **XLSX export is the slowest stage** on wide files (114.7 s for Fixture A);
  **the change report is the slowest stage** on long files with many changes
  (141.7 s for Fixture B's 125,000 changed fields).
- **Memory stays flat as files grow.** Peak heap was 122.9 MB and 125.9 MB — a
  file twice the size does not double memory use.
- **Expect roughly 5 minutes end to end** for a file of this scale on a typical
  laptop SSD, and expect the output to be larger than the input (the audit export
  adds original-value and confidence columns for every mapped field).
- **This is not a low-memory workload.** Peak RSS exceeded 1 GB for Fixture A.
  On a machine with less than 4 GB of free memory, process large files one at a
  time.

Benchmark fixtures are **not** shipped in the release package; they are hundreds
of megabytes of generated data. Recreate `samples/large_fixture.csv` with:

```
node scripts/make_large_fixture.mjs            # 100,000 rows x 5 columns
node scripts/make_large_fixture.mjs 100000 100 # the Fixture A shape
```

The workspace is designed for files of at least 100,000 rows and 100 columns, including
embedded line breaks and large text fields.

## How it stays memory-safe

- **Streaming parse.** CSV rows are streamed through `csv-parse`; the browser never loads
  the file (the upload streams the `File` object straight to the server), and the UI only
  ever renders a 20-row preview or a paginated slice.
- **Batched inserts.** Rows are written in batches of 1,000 inside a transaction per batch,
  so a failure rolls back only that batch and memory stays flat.
- **Event-loop yielding.** The processor yields with `setImmediate` between batches, so the
  catalog pages and the progress endpoint stay responsive while a large file runs.
- **Indexed lookups.** Canonical data is loaded once per run into normalized in-memory maps;
  project rows are indexed by `(project_id, row_number)` and `(project_id, review_required)`.

## Progress, cancellation and resume

- `GET /api/std/projects/:id/progress` reports status, processed rows and total rows; the
  Process page polls it and draws a progress bar.
- **Cancel** sets `cancel_requested`; the processor stops at the next row boundary, leaves
  the project in `Mapped` status and records how far it got.
- **Resume** restarts from `processed_rows + 1` without duplicating rows (rows are upserted
  on `(project_id, row_number)`).

## Practical advice

- Prefer CSV for very large files; XLSX parsing must materialize the worksheet.
- Keep the review queue manageable by using *Apply to All Identical Values* for repeated
  raw values — one decision can resolve thousands of rows.
- Write outputs to disk with **Write all outputs to disk** rather than downloading several
  large files through the browser.
- Uploaded files accumulate in `uploads/`; delete old ones when you no longer need the
  project's traceability. They are excluded from the release ZIP.
