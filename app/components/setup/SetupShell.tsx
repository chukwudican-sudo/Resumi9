'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { buildResume, isResumeUsable, sectionStatus, type ContactFact, type EntryWithBullets } from '../../lib/buildResume';
import { hasQuantity, profileStrength } from '../../lib/profileStrength';
import PdfPreview from '../applications/PdfPreview';
import MaterialList from './MaterialList';
import { checkReadiness } from '../../lib/readiness';
import { validateContact, type ContactField } from '../../lib/contactValidation';
import { confirmSectionReviewed } from '../../server/actions';
import DownloadPdf from '../applications/DownloadPdf';
import PolishButton from './PolishButton';
import type { ResumeSection, ResumeStructure } from '../../lib/types';
import { contentFor, entryKindFor, isRemovable, planSections } from '../../lib/sections';
import ContactSection, { type Contact } from './ContactSection';
import EntrySection from './EntrySection';
import SkillsSection, { type SkillGroup } from './SkillsSection';
import ProseSection from './ProseSection';
import ListSection from './ListSection';
import AddSection from './AddSection';
import SetupUpload from './SetupUpload';
import ReadinessPanel from './ReadinessPanel';
import Stages from '../Stages';
import Takeover from '../Takeover';
import NavTabs from '../NavTabs';
import { REASSURE } from '../../lib/waits';
import type { WaitControl, WaitRequest } from './waitControl';
import { useConfirm } from '../undo/ConfirmProvider';
import RemoveSection from './RemoveSection';

/**
 * Which section is open. Any key this person's resume actually has, plus
 * 'contact' — which is authored here and printed as the header rather than as a
 * section of its own.
 */
export type SectionKey = string;

/**
 * Where a resume gets built.
 *
 * A rail rather than a wizard: every section is reachable at any time, because
 * people do not fill a resume in order and being marched through one is what
 * makes these feel like paperwork. The preview beside it is the real resume,
 * rendered from what has been typed — not a thumbnail of a template.
 */
export default function SetupShell({
  initialEntries,
  initialFacts,
  initialContact,
  initialSections,
  polished,
  stale,
  savedAt,
  initialConfirmed,
}: {
  initialEntries: EntryWithBullets[];
  initialFacts: ContactFact[];
  initialContact: Contact;
  /** This person's own sections. Empty means the conventional set. */
  initialSections: ResumeSection[];
  polished: ResumeStructure | null;
  stale: boolean;
  savedAt: string;
  /** Sections already been through. See profiles.confirmedSections. */
  initialConfirmed: string[];
}) {
  const router = useRouter();
  const ask = useConfirm();

  /**
   * Getting out of a section with unsaved changes in it.
   *
   * The rail used to just call `setDirty(false)` and move, which threw the
   * changes away without a word — a summary typed and not saved, gone for
   * clicking the next thing in a list. It is the one loss neither the
   * confirmation on a delete nor the undo offer can reach, because nothing was
   * ever written down to put back.
   *
   * Only asks when there is something to lose.
   */
  async function mayLeave(): Promise<boolean> {
    if (!dirty) return true;
    return ask({
      title: 'Leave without saving?',
      body: `Your changes to ${open?.label ?? 'this section'} have not been saved yet.`,
      action: 'Discard',
    });
  }

  // Which section opens is local state, not a route — but it can be aimed from
  // outside. The cards elsewhere that offer to add a missing skill need to land
  // on Skills rather than on Contact, and a link is a great deal simpler than
  // teaching them to drive this component.
  const searchParams = useSearchParams();
  const [section, setSection] = useState<SectionKey>(() => searchParams.get('section') || 'contact');

  /**
   * The open section, written back to the address bar.
   *
   * It was read once, as a lazy initializer, and never written — so the URL
   * said `/setup` whichever section you were in. Two things fell out of that: a
   * refresh always dropped you back on Contact, and a second click on "add a
   * skill" from Insights or a nudge did nothing at all, because the link
   * resolved to a route the component was already mounted on and the
   * initializer had run long ago.
   *
   * `history.replaceState` rather than `router.replace`: the latter is a soft
   * navigation and would re-run this page's server component on every click in
   * the rail. This is Next's own escape hatch for a URL that should follow the
   * screen without fetching anything.
   *
   * Replace and not push, so the browser's back arrow — now the only back in
   * the app — leaves /setup in one press instead of walking backwards through
   * every section you looked at.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('section') === section) return;
    params.set('section', section);
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
  }, [section]);

  // And the other direction: a link aimed here while this is already mounted.
  // Next soft-navigates without remounting, so nothing would move without this.
  //
  // One known limit, and it is the cheaper end of a trade. `replaceState` is
  // invisible to Next's router, so its idea of the URL lags the address bar —
  // which means a link back to the section you originally arrived on can be
  // treated as a navigation to where it already is, and not fire. Closing that
  // would mean `router.replace`, and a server round-trip on every click in the
  // rail to fix a case that costs one more click.
  useEffect(() => {
    const wanted = searchParams.get('section');
    if (wanted) setSection(wanted);
  }, [searchParams]);
  const [contact, setContact] = useState(initialContact);

  // Polishing reads the database and writes corrections back to it, while an
  // open form holds its own copy in memory. Saving that copy afterwards puts
  // the old text back and the correction disappears — so the two are not
  // allowed to happen at once.
  const [dirty, setDirty] = useState(false);

  /**
   * Whether the contact details have been saved on this visit.
   *
   * Polish and Download stay shut until they have. The form already refuses to
   * save a link that is not a link — it lights up the field and stops — so
   * requiring the save is what makes that check unavoidable. Before this, an
   * imported value nobody had typed was never put to it: a resume arrived with
   * the word "LinkedIn" in the LinkedIn box, polished, downloaded, and went out
   * carrying a link that pointed at nothing.
   *
   * Read off the stored details rather than reset on arrival. What the save was
   * ever for is the validation — so asking whether the stored values PASS that
   * validation answers the same question without making somebody who changed
   * nothing press Save again to get their own download button back. The word
   * "LinkedIn" in the LinkedIn box still fails it, which is the case this
   * exists for; editing makes the form dirty and the save runs again.
   */
  const [contactSaved, setContactSaved] = useState(
    () => Object.keys(validateContact(initialContact as unknown as Record<ContactField, string>)).length === 0,
  );

  /**
   * Which sections have been been through, and saying so out loud.
   *
   * Kept locally as well as on the server so the tick lands on the press rather
   * than after a round trip; the write is what makes it survive leaving.
   */
  const [confirmed, setConfirmed] = useState<string[]>(initialConfirmed);
  function confirm(key: string) {
    setConfirmed((c) => (c.includes(key) ? c : [...c, key]));
    void confirmSectionReviewed(key);
  }
  /**
   * Read, not discarded.
   *
   * This was `const [, startTransition]`. router.refresh() does not resolve, so
   * without watching the transition the Save button un-dimmed while the server
   * was still rendering — leaving it live over a list that still showed the old
   * values. The one place in the app that got this right says why: "a second
   * click there spends a second credit."
   */
  const [refreshing, startTransition] = useTransition();

  // Entries and facts come straight from props rather than being copied into
  // state. router.refresh() re-renders the server component and hands down new
  // props, but a client component keeps its own state across that — so a copy
  // would still show the list as it was before the save, and an entry someone
  // just added would not appear until a full reload.
  const entries = initialEntries;
  const facts = initialFacts;
  const sections = initialSections;

  // Once the editorial pass has run, that is the resume — showing the raw
  // build beside a Download button that produces the polished one would be a
  // preview of something the person never receives.
  const built = useMemo(() => buildResume(entries, facts, sections), [entries, facts, sections]);
  // The rail and the page are read off the same plan, so they cannot disagree
  // about the order — which they did, visibly, until this.
  const status = useMemo(() => sectionStatus(built, contactSaved, confirmed), [built, contactSaved, confirmed]);
  const open = useMemo(() => status.find((s) => s.key === section) ?? status[0], [status, section]);
  const resume = polished ?? built;
  const doneCount = status.filter((s) => s.done).length;
  // Offering a download of a resume with no name and no history on it would
  // produce a page nobody wants to have sent.
  const usable = useMemo(() => isResumeUsable(entries, facts), [entries, facts]);
  // Where 'Save and continue' goes: the next section in the rail, wrapping to
  // the first. Hardcoding the successor per section is how a new one ends up
  // being a dead end nothing leads out of.
  const nextKey = status[(status.findIndex((s) => s.key === open?.key) + 1) % status.length]?.key ?? 'contact';
  // Where removing the open section lands you: the one above it. Falling back
  // to status[0] would throw somebody to Contact for deleting something near
  // the bottom of their resume.
  const previousKey =
    status[Math.max(0, status.findIndex((s) => s.key === open?.key) - 1)]?.key ?? 'contact';

  // Whether there is enough here to compile. The same check the download and
  // the preview endpoint make, so the pane never shows a resume that the
  // buttons beside it would refuse to produce.
  //
  // The whole result is kept now, not just `.ready`. The list of what is
  // standing in the way was computed on every render and discarded — see
  // ReadinessPanel.
  const readiness = useMemo(() => checkReadiness(resume), [resume]);
  const ready = readiness.ready;

  // Scored here rather than read from profiles.strength, and scored on `built`
  // rather than on `resume`. The stored figure lags a save behind, and the
  // polished structure holds rewritten bullets — either would put a number in
  // the rail that disagrees with the marks two columns over, which are read off
  // these same rows. This way the two cannot contradict each other, and the
  // score moves the moment somebody types a number.
  const strength = useMemo(() => profileStrength(built), [built]);

  // Which sections still hold an entry whose bullets carry no number. Counted
  // per section rather than as one total: the line below is a jump, and a count
  // spanning experience and projects has nowhere honest to land.
  const thin = useMemo(() => {
    const count = (list: { bullets?: string[] }[]) =>
      list.filter((e) => (e.bullets ?? []).length > 0 && !(e.bullets ?? []).some(hasQuantity)).length;
    return (
      [
        { key: 'experience' as const, noun: 'experience', count: count(built.experience ?? []) },
        { key: 'projects' as const, noun: 'project', count: count(built.projects ?? []) },
      ] satisfies { key: string; noun: string; count: number }[]
    ).filter((w) => w.count > 0);
  }, [built]);

  /**
   * What the pane is showing instead of the resume, if anything.
   *
   * Held here rather than in the button that started it: the wait belongs where
   * the result will appear, and the three controls that can start one — Polish,
   * Download-on-a-stale-resume, and the uploader — all live somewhere else on
   * the screen.
   */
  const [wait, setWait] = useState<(WaitRequest & { percent?: number; done: boolean }) | null>(null);

  const waitControl: WaitControl = useMemo(
    () => ({
      start: (request) => setWait({ ...request, done: false }),
      progress: (percent) => setWait((w) => (w ? { ...w, percent } : w)),
      finish: () => setWait((w) => (w ? { ...w, done: true } : w)),
      cancel: () => setWait(null),
    }),
    [],
  );

  function afterSave() {
    startTransition(() => router.refresh());
  }

  const skillGroups: SkillGroup[] = useMemo(
    () =>
      facts
        .filter((f) => f.category === 'skill')
        .map((f) => {
          const colon = f.text.indexOf(':');
          return colon > 0
            ? { category: f.text.slice(0, colon).trim(), items: f.text.slice(colon + 1).trim() }
            : { category: 'Skills', items: f.text.trim() };
        }),
    [facts],
  );

  // Read off the built resume rather than the rows, so the editor is filled
  // with exactly what the page beside it is printing.
  function proseOf(key: string): string {
    const content = contentFor(built, { key, label: '', shape: 'prose', optional: true });
    return content.shape === 'prose' ? content.text : '';
  }

  function groupsOf(key: string): SkillGroup[] {
    const content = contentFor(built, { key, label: '', shape: 'groups', optional: true });
    return content.shape === 'groups' ? content.groups : [];
  }

  function itemsOf(key: string): string[] {
    const content = contentFor(built, { key, label: '', shape: 'list', optional: true });
    return content.shape === 'list' ? content.items : [];
  }

  // Importing replaces the whole profile, so it takes the whole window — the
  // rail, the editor and the preview are all about to be something else.
  if (wait?.scope === 'window') {
    return (
      <Takeover
        title={wait.title}
        steps={wait.steps}
        done={wait.done}
        percent={wait.percent}
        estimate={wait.estimate}
      />
    );
  }

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-ground font-sans text-ink">
      <div className="flex h-[62px] shrink-0 items-center justify-between border-b border-rule bg-ground-surface px-8">
        {/*
          The same left-hand side as every other signed-in page.
          
          This bar is /setup's own rather than AppNav, because it also carries
          Polish, Download and Done — and the cost of that was the one screen
          that IS a nav tab being the only one you could not navigate from.

          Through mayLeave, because every way off this page has to ask the same
          question. A plain Link would be the quickest route to losing a form.
        */}
        <NavTabs
          active="profile"
          onNavigate={async () => {
            if (!(await mayLeave())) return false;
            setDirty(false);
            return true;
          }}
        />

        <div className="flex items-center gap-4">
          <span className="text-[13px] text-ink-muted">{doneCount} of {status.length} sections</span>
          {dirty ? (
            <span className="text-[12.5px] text-ink-faint">Save or cancel first</span>
          ) : null}
          {usable ? <PolishButton stale={stale} disabled={dirty || refreshing || !contactSaved} wait={waitControl} /> : null}
          {usable ? <DownloadPdf polishFirst={stale} disabled={dirty || refreshing || !contactSaved} wait={waitControl} /> : null}
          {/*
            A button rather than a Link, so leaving the page asks the same
            question the rail does. A <Link> navigates before anything can be
            said about the unsaved form underneath it.
          */}
          {/*
            Done tidies up on the way out.
            
            The editorial pass used to run when you pressed Tailor on a job
            application — two model calls in front of somebody waiting on a
            resume, and half of a two-minute wait. The work is worth doing; the
            moment was wrong. Here you have already finished, and the pane is
            free to carry it.
            
            Only when the resume has actually changed since the last pass, and
            never at the cost of leaving: a failure still lets you go.
          */}
          <button
            type="button"
            onClick={async () => {
              if (!(await mayLeave())) return;
              setDirty(false);

              router.push('/applications');
            }}
            className="rounded bg-accent px-5 py-2.5 text-sm font-medium text-ground transition hover:bg-accent-hover"
          >
            Done
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-grow grid-cols-1 overflow-y-auto lg:grid-cols-[252px_minmax(0,1fr)_minmax(560px,0.42fr)] lg:overflow-hidden">
        {/* rail */}
        <nav className="min-h-0 border-b border-rule px-5 py-6 lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <div className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
            {status.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={async () => {
                  if (!(await mayLeave())) return;
                  setDirty(false);
                  setSection(s.key);
                }}
                className={`flex shrink-0 items-center gap-3 rounded-md px-3 py-2.5 text-left transition lg:w-full ${
                  section === s.key ? 'bg-accent-tint' : 'hover:bg-ground-panel'
                }`}
              >
                <span
                  className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full ${
                    s.done ? 'bg-accent' : 'border-[1.5px] border-rule-field'
                  }`}
                >
                  {s.done ? (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  ) : null}
                </span>
                <span className="flex flex-col">
                  <span className={`text-sm ${section === s.key ? 'text-ink' : 'text-ink-prose'}`}>
                    {s.label}
                  </span>
                  <span className="hidden text-[12px] text-ink-faint lg:block">{s.detail}</span>
                </span>
              </button>
            ))}
          </div>

          {/*
            Under the sections rather than beside them: it is the end of the
            list, not a control over it. Held shut while a form is dirty for the
            same reason Polish and Download are — adding refreshes the page, and
            an open unsaved form would go with it.
          */}
          <AddSection
            taken={new Set(status.map((s) => s.key))}
            disabled={dirty || refreshing}
            onAdded={(key) => { setDirty(false); setSection(key); }}
            onUndone={() => { setDirty(false); setSection(previousKey); afterSave(); }}
          />

          {/*
            Uploading is no longer something only onboarding can do.

            Choosing "Fill it in myself" used to be a one-way door: the only way
            to change your mind was to get back to a screen with no route to it.
            Offering the file here means never needing to go backwards for it —
            which is also what lets the back control above mean one fixed thing.
          */}
          <SetupUpload
            disabled={dirty || refreshing}
            imported={entries.some((e) => e.source === 'resume_import')}
            entryCount={entries.length}
            sectionCount={sections.length}
            hasSkills={skillGroups.length > 0}
            onDone={afterSave}
            wait={waitControl}
          />

          {/*
            The diagnosis, which used to live on a separate read-only page that
            listed the same entries over again. Here it sits beside the forms
            that answer it.

            Inset by the same 12px as the section labels above: the buttons
            carry their own padding, so a block flush to the rail's edge left a
            ragged margin down the column with the text in two different places.

            Hidden below lg, where this same nav is a horizontal strip of
            buttons: a status card in that strip would scroll off sideways next
            to them, and on a phone the marks on each entry are the useful half.
          */}
          <div className="mt-7 hidden border-t border-rule pt-7 lg:block">
            <div className="flex flex-col px-3">
              <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                Profile strength
              </span>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="font-serif text-[38px] leading-none">{strength}</span>
                <span className="text-[13px] text-ink-faint">/ 100</span>
              </div>
              <div className="mt-3.5 h-1 overflow-hidden rounded-sm bg-rule">
                <div
                  className="h-full rounded-sm bg-accent transition-[width] duration-500"
                  style={{ width: `${strength}%` }}
                />
              </div>
              <p className="mt-3.5 text-[12.5px] leading-relaxed text-ink-muted">
                The stronger this is, the less you edit after every tailor.
              </p>

              {/*
                A suggestion, not a correction. This replaced an amber banner
                under a warning triangle reading "One entry has no numbers in
                it — a few questions would fix it", which stated a defect about
                somebody's career and offered twenty-five questions to mend one
                bullet. Nothing here is flag-coloured, nothing carries an icon,
                and once every entry has a number the block renders nothing
                rather than turning green.
              */}
              {thin.length ? (
                <div className="mt-6 flex flex-col gap-2">
                  <p className="text-[12.5px] leading-relaxed text-ink-muted">
                    Numbers are what make a bullet land &mdash; a percentage, a count, time saved.
                  </p>
                  {thin.map((w) => (
                    <button
                      key={w.key}
                      type="button"
                      // Through mayLeave like the rail and the readiness panel.
                      // This was the third way out of an unsaved form that did
                      // not ask, and the last one left.
                      onClick={async () => {
                        if (!(await mayLeave())) return;
                        setDirty(false);
                        setSection(w.key);
                      }}
                      className="text-left text-[12.5px] leading-relaxed text-accent transition hover:text-accent-hover hover:underline hover:underline-offset-2"
                    >
                      {w.count} {w.noun} {w.count === 1 ? 'entry does' : 'entries do'} not have one yet &rarr;
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

        </nav>

        {/* the section being edited */}
        <div className="min-h-0 px-6 py-8 sm:px-10 lg:overflow-y-auto">
          <div className="mx-auto max-w-[560px]">
            {/*
              Dispatched on SHAPE, not on name — the same decision the renderer
              makes two columns over. There are five ways to edit a section and
              three of them already existed, which is what made an unfamiliar
              section affordable: Extracurriculars is Experience with a
              different heading, not a new editor.

              Keyed on the section throughout. Without that, React sees the same
              element type in the same position and keeps the instance — so an
              entry left open for editing stayed open when you moved to another
              section, and its form re-rendered under the new kind holding the
              old entry's data.
            */}
            {!open || open.shape === 'contact' ? (
              <ContactSection
                contact={contact}
                // The server's copy, straight from the prop rather than from the
                // state above: that state is the draft and never re-syncs, so it
                // cannot say what is actually stored.
                stored={initialContact}
                onChange={setContact}
                onSaved={() => { setContactSaved(true); confirm('contact'); afterSave(); }}
                onNext={() => setSection(nextKey)}
                onDirty={setDirty}
              />
            ) : open.shape === 'groups' ? (
              <SkillsSection
                key={open.key}
                sectionKey={open.key}
                label={open.label}
                groups={open.key === 'skills' ? skillGroups : groupsOf(open.key)}
                onSaved={() => { confirm(open.key); afterSave(); }}
                onDirty={setDirty}
              />
            ) : open.shape === 'prose' ? (
              <ProseSection
                key={open.key}
                sectionKey={open.key}
                label={open.label}
                text={proseOf(open.key)}
                onSaved={() => { confirm(open.key); afterSave(); }}
                onDirty={setDirty}
              />
            ) : open.shape === 'list' ? (
              <ListSection
                key={open.key}
                sectionKey={open.key}
                label={open.label}
                items={itemsOf(open.key)}
                onSaved={() => { confirm(open.key); afterSave(); }}
                onDirty={setDirty}
              />
            ) : (
              <EntrySection
                key={open.key}
                kind={entryKindFor(open.key)}
                sectionKey={open.key}
                label={open.label}
                entries={entries}
                onChange={() => { if (open) confirm(open.key); afterSave(); }}
                onNext={() => { if (open) confirm(open.key); setSection(nextKey); }}
                onDirty={setDirty}
              />
            )}

            {/*
              One control for five editors. Put inside each of them it would be
              five copies of the same confirmation, and four chances for them to
              drift apart.

              Not offered for Contact, nor for the four the conventional
              fallback restores — removing one of those is a button that does
              nothing, which is worse than not having it.
            */}
            {open && open.shape !== 'contact' && isRemovable(open.key) ? (
              <RemoveSection
                // Prefixed, because this is a SIBLING of the editor above and
                // React keys only have to be unique among siblings — which is
                // exactly what makes sharing one so quiet. mapRemainingChildren
                // builds a Map keyed by key, so the second child overwrites the
                // first; cleanup then deletes only what is still in that map,
                // and the orphaned editor is never unmounted. Switching between
                // two sections left both on screen, then three.
                key={`remove-${open.key}`}
                sectionKey={open.key}
                label={open.label}
                entries={entries.filter((e) => e.kind === entryKindFor(open.key)).length}
                onRemoved={() => { setDirty(false); setSection(previousKey); afterSave(); }}
              />
            ) : null}
          </div>
        </div>

        {/* the actual resume, not a thumbnail */}
        {/*
          `relative` here and the scrolling moved inside, so the wait below can
          sit on the VISIBLE pane. An absolutely-positioned overlay inside a
          scroll container covers the full scroll height instead — fine on a
          short resume, and a scrim that stops halfway down a long one.
        */}
        <aside className="relative hidden min-h-0 flex-col border-l border-rule bg-ground-band lg:flex">
        <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-8">
          {ready ? (
            // The real document, once there is enough to make one. Not a
            // drawing of it — the drawing and the download disagreed about
            // section order, coursework and page count within one week.
            <>
              {/*
                Says what this document IS. Without it the preview reads as the
                finished article, and somebody polishes and re-polishes trying
                to get the page they want to send — when the page they send is
                built per job, from this one.

                Deliberately does not promise that section order is editable
                per job. It is not: polish decides the order, and the tailoring
                cannot return sections at all.
              */}
              <div className="mb-4 flex w-full flex-col gap-1.5 self-start">
                <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                  Your resume
                </span>
                <p className="max-w-[46ch] text-[12px] leading-relaxed text-ink-muted">
                  Your base resume. Every job you apply to gets its own tailored copy of this
                  &mdash; you edit that copy per job.
                </p>
              </div>
              <PdfPreview reloadKey={savedAt} />
            </>
          ) : (
            // Not ready. The pane is otherwise dead space for the whole of
            // somebody's first session — "Nothing yet" above a blank rectangle
            // — while the app is holding the exact list of what is missing.
            <div className="flex w-full flex-col">
              <ReadinessPanel
                blocking={readiness.blocking}
                // Through the same guard the rail uses. Jumping straight to the
                // section would be a way out of an unsaved form that does not
                // ask — the one hole the rail was just closed against.
                onGo={async (key) => {
                  if (!(await mayLeave())) return;
                  setDirty(false);
                  setSection(key);
                }}
              />
              <MaterialList entries={entries} facts={facts} sections={sections} />
            </div>
          )}
        </div>

        {/*
          The wait, where the result will appear.
          
          Not beside Polish or Download — there is deliberately nothing beside
          those — and not replacing the resume either. It dims what is already
          there, so you keep seeing what you have while it is being changed.
          The pane already did exactly this for a preview reload.
        */}
        {wait?.scope === 'pane' ? (
          <div className="absolute inset-0 z-10 flex animate-[fadeIn_180ms_ease-out] items-center justify-center bg-ground-band px-8">
            <div className="w-full max-w-[290px]">
              <Stages
                steps={wait.steps}
                done={wait.done}
                percent={wait.percent}
                estimate={wait.estimate}
                reassure={REASSURE}
                onSettled={() => setWait(null)}
              />
            </div>
          </div>
        ) : null}
        </aside>
      </div>
    </main>
  );
}
