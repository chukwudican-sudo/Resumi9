# Working in this repository

## Run it the way it will be used, then say what you ran

**Before handing anything back, execute it the way it will actually be
executed, and state in the reply what you ran and what came out.** Not "it
typechecks", not "the tests pass" — those are necessary and they are not the
claim. The claim is that the thing worked.

This rule is not a principle, it is a list of what has already happened here.
Every one of these typechecked, every one was reviewed, and every one failed
the first time it was run:

| what | how it failed |
|---|---|
| `scripts/health.ts` | `coalesce((case …, case …), 120)` — brackets round a comma list are a ROW constructor. Postgres refused the whole script. The queries had never been sent to a database. |
| `scripts/feedback.selftest.ts` | top-level `await` in a file tsx compiles to CJS. It would not start at all. `tsc` allows it because the tsconfig module target is ESNext. |
| the same file's `--dry` mode | opened a transaction with a raw `begin`, then called a repository function that opened its OWN transaction on the same connection, whose `commit` ended the outer one. The dry run committed the migration it was meant to be proving. |
| the feedback inbox | `row.created_at as Date` on a `db.execute` result. A cast is a promise, not a conversion; the page threw `createdAt.getTime is not a function` on the first real row. Second time in this file — see `rawRows.test.ts`. |
| `scripts/inbox.render.ts` | `process.argv.find(a => a.startsWith('/'))` resolved to **the node binary's own path**, which the script then deleted recursively. It destroyed the node installation it was running on. |

So, by artifact:

- **A query** — run it against the real database. Reading rows is not enough:
  call the methods the caller will call. `assert(row)` only proves a row came
  back; the inbox bug survived a passing self-test because nothing ever called
  `.getTime()`.
- **A script** — start it. `tsc` and the test runner compile differently from
  `tsx`, and a script that cannot start is not caught by either. Pointing
  `DATABASE_URL` at a dead port is enough to prove it boots without touching
  anything.
- **A page** — render it with real rows. If it needs a session a test cannot
  have, split it: the page does the auth and the fetch, a component takes the
  data. `scripts/inbox.render.ts` is the worked example — it mounts the real
  client bundle and drives it in a browser, because a static render proves the
  markup and none of the behaviour.
- **A route** — call it over HTTP, signed out as well as signed in.
- **A migration** — apply it inside a transaction and roll it back
  (`feedback.selftest.ts --dry`), or watch Alex apply it. Never claim an
  unapplied migration works.

If something could not be run, **say so plainly and say why**. "I could not
run X because the sandbox refused it" is a useful sentence. "It works" about
something unexecuted is not.

## Destructive calls

`fs.rmSync(path, { recursive: true, force: true })`, `rm -rf`, `DROP`,
`DELETE` without a `where`: derive the target, then **prove** it before using
it.

- `process.argv[0]` is the interpreter and `argv[1]` is the script. Only
  `slice(2)` is anything a person typed.
- A delete target must be somewhere a scratch directory belongs *and* must
  carry a marker file the script itself wrote. Either check alone would have
  prevented the node incident; both are cheap.
- A script that writes to production must roll back, or delete by an exact id
  it generated, and then verify the count returned to what it was.

## This codebase

- **Resumi9 is multi-user.** Every fix must be general. Nothing tuned to one
  profile, one posting, or one person's rules.
- **Never write to Alex's own account or profile data.**
- `npx tsx --test "app/**/*.test.ts"` is the suite. `npm run build` typechecks
  the app. There is no ESLint config — `next lint` offers to create one, which
  is why `rawRows.test.ts` enforces by reading source.
- Every exported function in `app/server/db/repository.ts` takes `userId`
  first and scopes its query by it. The three feedback functions that do not
  are named `…AcrossUsers` so the exception is loud.
- `db.execute` returns raw driver values; `db.select()` applies the column
  mappers. Prefer the query builder. Where a raw query is genuinely needed,
  convert with `toDate` and coerce numbers with `Number()` — never cast.
- Migrations live in `drizzle/`, are applied by Alex in the Supabase SQL
  editor, and enable RLS with no policies on anything the browser must not
  reach.
- **No AI attribution in commits.** No `Co-Authored-By`, no "Generated with".

## Working with Alex

- **Change nothing until he says to build.** Answering a question, saying
  "whatever works best", or reacting to a problem you raised is not approval.
- **One question per message**, in plain words.
- **Always say what is weak in your own plan** before finalising it.
