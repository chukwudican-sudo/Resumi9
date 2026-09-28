/**
 * Does a resume still reach one page after the template changes?
 *
 *   npx tsx scripts/fit-shapes.ts
 *
 * **Run this whenever assets/main.tex or the preamble in lib/latexEngine.ts
 * moves.** Every page count in the app depends on that template, and the change
 * that exposed the need for this — turning off the f-ligatures, so that
 * "officer" stops extracting as "oﬀicer" — altered how every line is set. It
 * happened not to reflow anything. The next one might.
 *
 * Not in the test suite, because it is sixty real compiles and about a minute
 * and a half, and it needs tectonic on the machine. `npx tsx --test` has to
 * stay something anybody runs without thinking.
 *
 * **The shapes are real; the writing is invented.** They were measured from the
 * ten most recent tailored resumes, one per account, on 2026-09-28: how many
 * jobs, how many projects, how many bullets under each, whether there was a
 * summary, how many skill groups, and the average bullet length in words.
 * Nothing else was copied. Real bullets describe a real person's employer,
 * university and projects, and putting nine strangers' work in a git repository
 * to guard against a formatting regression is not a trade worth making.
 *
 * What a shape cannot carry is that a bullet's length decides whether it wraps
 * to a second line, and a resume sits one line from a page break or ten. So
 * these are a regression alarm, not a simulation: if a template change takes
 * fitters below what they manage today, something has moved.
 */
import { fitToPages } from '../app/lib/fit';
import { renderResumeLatex } from '../app/lib/latexEngine';
import { compileWithMeta } from '../app/server/pdf';
import type { ResumeStructure } from '../app/lib/types';

/** jobs and projects as bullet counts per entry, plus the rest of the page. */
interface Shape {
  name: string;
  jobs: number[];
  projects: number[];
  education: number[];
  skillGroups: number;
  summary: boolean;
  wordsPerBullet: number;
}

/** Measured 2026-09-28. R4 and R10 were identical and are kept once. */
const SHAPES: Shape[] = [
  { name: 'three jobs, three projects', jobs: [3, 2, 2], projects: [3, 2, 2], education: [1], skillGroups: 3, summary: false, wordsPerBullet: 22 },
  { name: 'three and three, five skill groups', jobs: [3, 2, 2], projects: [2, 2, 2], education: [1], skillGroups: 5, summary: false, wordsPerBullet: 23 },
  { name: 'no projects at all', jobs: [5, 2, 2], projects: [], education: [0], skillGroups: 4, summary: true, wordsPerBullet: 15 },
  { name: 'ten entries', jobs: [3, 2, 2, 2], projects: [4, 4, 4, 2, 3, 1], education: [1], skillGroups: 5, summary: false, wordsPerBullet: 22 },
  { name: 'one job, three projects', jobs: [3], projects: [2, 2, 3], education: [0], skillGroups: 4, summary: true, wordsPerBullet: 20 },
  { name: 'two long jobs', jobs: [4, 4], projects: [2, 4, 2], education: [2], skillGroups: 5, summary: false, wordsPerBullet: 20 },
  { name: 'three jobs, two full projects', jobs: [3, 2, 3], projects: [4, 4], education: [2], skillGroups: 3, summary: true, wordsPerBullet: 18 },
  { name: 'one job, four projects', jobs: [5], projects: [4, 4, 4, 2], education: [2], skillGroups: 4, summary: false, wordsPerBullet: 14 },
  { name: 'two and two', jobs: [3, 3], projects: [2, 3], education: [1], skillGroups: 4, summary: true, wordsPerBullet: 19 },
];

const WORDS =
  'built shipped designed measured rebuilt reduced raised cut tracked automated tested documented migrated profiled instrumented refactored delivered analysed scheduled verified'.split(
    ' ',
  );

/** A bullet of roughly the right length, deterministic so runs compare. */
function bullet(seed: number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i += 1) out.push(WORDS[(seed * 7 + i * 3) % WORDS.length]);
  const text = out.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function build(shape: Shape): ResumeStructure {
  let seed = 0;
  const bullets = (n: number) => Array.from({ length: n }, () => bullet(seed++, shape.wordsPerBullet));

  return {
    name: 'Sample Person',
    contact: { email: 'sample@example.com', phone: '000-000-0000', linkedin: 'https://linkedin.com/in/sample' },
    summary: shape.summary ? bullet(99, 34) : null,
    education: shape.education.map((n, i) => ({
      school: `Example University ${i + 1}`,
      degree: 'BSc Something',
      location: 'Somewhere, ON',
      dates: '2022 – 2026',
      bullets: bullets(n),
    })),
    experience: shape.jobs.map((n, i) => ({
      title: `Position Number ${i + 1}`,
      org: `Employer Number ${i + 1}`,
      location: 'Somewhere, ON',
      dates: '2024 – 2025',
      bullets: bullets(n),
    })),
    projects: shape.projects.map((n, i) => ({
      name: `Project Number ${i + 1}`,
      tech: 'TypeScript, PostgreSQL',
      dates: '2025',
      bullets: bullets(n),
    })),
    skills: Array.from({ length: shape.skillGroups }, (_, i) => ({
      category: `Group ${i + 1}`,
      items: 'One, Two, Three, Four, Five, Six',
    })),
    certifications: [],
    awards: [],
  } as unknown as ResumeStructure;
}

async function main() {
  const measure = async (s: ResumeStructure) => (await compileWithMeta(renderResumeLatex(s))).pages;
  let fitted = 0;
  let already = 0;
  let failed = 0;

  for (const shape of SHAPES) {
    const structure = build(shape);
    const before = await measure(structure);
    if (before === null) {
      failed += 1;
      console.log(`  ${shape.name.padEnd(32)} WOULD NOT COMPILE`);
      continue;
    }
    if (before <= 1) {
      already += 1;
      console.log(`  ${shape.name.padEnd(32)} already one page`);
      continue;
    }

    // No model ranking: what is under test is the app's own escalation, which
    // is the half that has to keep working when the template moves.
    const out = await fitToPages(structure, { target: 1, cuts: [], measure, affords: () => true });
    const after = await measure(out.structure);
    const kept = out.structure.experience.length + out.structure.projects.length;
    const total = shape.jobs.length + shape.projects.length;

    if (after !== null && after <= 1) {
      fitted += 1;
      console.log(`  ${shape.name.padEnd(32)} ${before} pages → 1, ${kept}/${total} entries kept`);
    } else {
      failed += 1;
      console.log(`  ${shape.name.padEnd(32)} STILL ${after ?? 'un'}${after === null ? 'measurable' : ' PAGES'} — the template got longer`);
    }
  }

  console.log(`\n${already} already fitted · ${fitted} brought to one page · ${failed} could not`);
  if (failed > 0) {
    console.error(
      '\nA shape that used to reach one page no longer does. Either the template got\n' +
        'denser to no purpose, or the fitter stopped escalating. Both are regressions.',
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
