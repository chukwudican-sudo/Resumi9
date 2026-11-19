# Deferred work

Things found, understood, and deliberately not done yet. An item is here
because somebody decided to leave it, not because nobody noticed it — each
one says what the evidence was, so the next person does not have to rediscover
it before they can judge it.

Not a wish list. If something here turns out not to be worth doing, delete it
and say why in the commit.

---

## Telemetry — nothing is measured in production

The app has no record of what it does to real resumes. Everything known about
its behaviour comes from `scripts/acceptance.ts`, which runs eight invented
profiles on demand, and from reading one account's saved rows by hand.

- **Store the pre-revert text.** When the honesty passes trim or revert a
  bullet, the rewritten version is discarded. The change log names the claim
  but not the sentence that was replaced, so nobody can tell afterwards
  whether a revert was right. Keeping it alongside the saved resume is the
  only way to audit the checks against real work.
- **Aggregate reverts across users.** Per-resume counts exist only inside a
  single run. How often a check fires, which check, and on what kind of
  bullet are the numbers that would say whether a threshold is set well.
- **Record failures at all.** Two error shapes showed up in a 48-combination
  harness run — `Failed query:` from Postgres and `Request was aborted` from
  the 110s request budget — and there is no way to tell whether real users
  hit either, because nothing writes them down. The second is certainly
  reachable in production: a tailor slower than `REQUEST_BUDGET_MS` aborts
  and the route returns a 504.

## Ask the verifier whether a cut sentence still reads

`honesty.ts/withoutSpan` decides whether a trimmed bullet is printable using
hand-written English rules: a span may not end on a preposition, a trailing
clause may not fall under three words, a span directly after the opening verb
may not be closed over by a preposition. Each one was written after watching
it go wrong on a real resume — "Cached station reads to one query instead of
forty", "Coordinated across two seasonal campaigns", "…, strengthening
skills" — and each is a rule about English rather than about this person's
work.

Rules like that catch the shapes somebody has already seen and nothing else.
The claim check already has a model reading these bullets; asking it whether
the cut sentence still reads complete and specific, and falling back when it
does not, would cover the shapes nobody has seen yet. Keep the rules as a
cheap first filter so the common cases never reach a model call.

Deliberately after the revert work, not during it: a model in the loop here
would have made the three failures above harder to see, and they were the
evidence that the cut needed guarding at all.

## (3) Trait words from a posting

A posting for a supply-chain role is full of "accuracy", "attention to
detail", "documentation". The tailor is told to use the employer's
vocabulary and also told never to claim a trait the structure does not
evidence, and those two instructions meet head-on when the employer's
distinguishing vocabulary IS trait language. The writer reaches for it, the
verifier takes it back.

Decided direction: the writer may use a trait word only where the profile
supports it, and where it does not, surface it to the person as a question
rather than inventing it or silently reverting.

## (4) Entry relevance, judged by meaning

`cutOrder` is the model's ranking of what to drop, and it is trusted
outright. Measured on a real supply-chain posting, it ranked the procurement
job **third most droppable of forty** while simultaneously returning that job
as kept and writing in its log that the resume "leads with" it — two fields
of one tool call disagreeing. The fitter executed the ranking faithfully and
the most relevant job came off the page.

Must work outside tech, so keyword overlap is not enough: a nursing or
marketing profile has no tech line to score. Also in this item: write the
change log **after** the guard, so a log line cannot describe an ordering the
guard has already undone.

## (5) Skills, and the constants

- The fitter can only drop whole skills LINES, never terms within a line.
  Losing a whole line loses every ATS keyword on it.
- `MIN_JOBS = 3`, `MIN_PROJECTS = 2`, `MIN_BULLETS = 2`, `MIN_SKILL_LINES = 3`
  and `MAX_SKILL_LINES = 5` are app constants measured on one profile during
  one apply run — the comments in `fit.ts` say so. A three-job floor is wrong
  for a one-job student and for a six-job senior alike. Derive the budgets
  from the page budget and the person's own rules.
- **Check 8 fails for `senior-two-page`**: two different postings sometimes
  produce an identical skills selection for a profile with twelve terms and
  room to choose. Noisy run to run, and it predates the revert work. Belongs
  here rather than with the honesty checks.

## (6) Data model

- **Entries have no stable id in `ResumeStructure`.** `profile_entries` has a
  real `id`; the structure does not carry it, and `annotate` mints `e0`/`p2`
  from array position at tailor time. So `fit.ts/droppedKey` identifies a
  dropped entry by name and dates, which orphans the record when somebody
  edits that entry. `couldComeBack` works around it by dropping records that
  match neither the profile nor the page — a mitigation, not a fix.
- Entries should be able to hold **alternate titles** and a **locked** flag,
  so "use this title on technical roles" is data rather than a prose rule the
  model has to interpret.
- Sort experience by a **date convention or the person's choice**, not by the
  order rows happen to be in.
- Convert **prose rules into checks** wherever possible. A rule with
  `check: null` is enforced by nothing but the model reading it, and the
  Rules page shows it as "Guidance" — the title rule is one of these, and a
  model cited it wrongly in a real change log.

## Data cleanup, optional

Fourteen saved resumes on one account carry a duplicated or index-collided
entry in their `dropped` list, from a fitter regression live between 6 and 16
November. **They behave correctly** — the read-time dedupe and the identity
key in `couldComeBack` handle both shapes — so this is cosmetic: a single
`UPDATE` deduping `resumes.dropped`. The saved change-log text on those
versions still reads "Dropped 4 projects … Kudi Kitchen, Kudi Kitchen …" and
should be left alone; it is the record of what the app said at the time.
