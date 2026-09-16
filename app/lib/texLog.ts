/**
 * How many pages the compiler said it wrote.
 *
 * The app had no idea how long a resume was. The model was asked to guess and
 * was wrong every time it was checked — "may run slightly over 1 page" for a
 * resume that filled two, "close to 2 pages" for another that did the same —
 * and that guess was what a person's page rule would have been judged against.
 *
 * The compiler knows exactly. XeTeX ends every run with a line naming the file
 * and the count, and tectonic 0.16.9 prints it with `--print` and keeps it in
 * the log with `--keep-logs`:
 *
 *     Output written on main.pdf (2 pages, 38717 bytes).
 *
 * Confirmed against the real profile before anything was built on it. Parsing
 * that line beats parsing the PDF: page objects hide inside compressed object
 * streams, so counting them means a PDF library on the server, a Node version
 * floor, and a bundler exception — for a number the compiler already printed.
 *
 * Pure, and shared: the app reads it after a local compile, and the compile
 * service reads the same line to put a page count in its response header. Two
 * readers, one pattern, so they cannot drift.
 */

/**
 * The line looks like `Output written on main.pdf (2 pages, 38717 bytes).`
 *
 * The filename is deliberately not pinned — tectonic writes `main.pdf`, plain
 * XeTeX writes `main.xdv`, and which one appears depends on the engine's mood
 * about intermediate formats. A singular "1 page" has no "s".
 */
const WRITTEN = /Output written on [^(]*\((\d+)\s+pages?/i;

/**
 * The page count from a compiler's chatter, or null when it did not say.
 *
 * Null is a normal answer, not an error: a cached compile has no fresh log, and
 * an older compile service does not send one. Everything downstream treats "not
 * measured" as a fact to state rather than a failure — a page rule reads as
 * guidance, and the resume still saves.
 */
export function pagesFromLog(chatter: string | null | undefined): number | null {
  const found = WRITTEN.exec(chatter ?? '');
  if (!found) return null;
  const pages = Number(found[1]);
  return Number.isInteger(pages) && pages > 0 ? pages : null;
}
