import { ResumeStructure } from './types';
import { contentFor, hasContent, planSections } from './sections';

// ponytail: the preamble below is duplicated verbatim from assets/main.tex
// (lines 1-104, everything above \begin{document}). That file stays as the
// human-readable source of provenance; we embed rather than read at runtime
// so the engine is a pure function with no filesystem/network dependency.
const PREAMBLE = String.raw`%-------------------------
% Resume in Latex
% Author : Jake Gutierrez
% Based off of: https://github.com/sb2nov/resume
% License : MIT
%------------------------

\documentclass[letterpaper,11pt]{article}

\usepackage{latexsym}
\usepackage[empty]{fullpage}
\usepackage{titlesec}
\usepackage{marvosym}
\usepackage[usenames,dvipsnames]{color}
\usepackage{verbatim}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\usepackage{fancyhdr}
\usepackage[english]{babel}
\usepackage{tabularx}
% ponytail: dropped \input{glyphtounicode} + \pdfgentounicode=1 — those are
% pdftex-only primitives, and we compile with tectonic (XeTeX engine), which
% errors on them.
%
% That note used to end "cost: slightly weaker ATS glyph->unicode mapping",
% which understated it. The map is present under XeTeX and is WRONG for one
% glyph. Read out of a compiled PDF's own ToUnicode table:
%
%     glyph <007A> -> U+0066 U+0066   = "ff"   correct
%     glyph <007D> -> U+0066 U+0069   = "fi"   correct
%     glyph <007B> -> U+FB00 U+0069   = "ffi"  WRONG — a ligature character
%
% So "officer" extracts as "o" + the ff ligature + "icer", and an employer's
% system searching for "Chief Financial Officer" does not match it. Same for
% office, efficient, efficiency, difficult, staffing, traffic, sufficient. It
% is invisible on screen: PDF readers normalise the ligature back to "ff",
% which is why it survived this long on a product whose whole job is putting
% a posting's own words onto a resume.
%
% Turning the f-ligatures off fixes the one broken mapping. It also gives up
% the three that were correct, which is a real if small typographic loss —
% worth it, because this document is read by machines before it is read by
% anybody. Named by file rather than by family: \setmainfont{Latin Modern
% Roman} does not resolve under tectonic.
\usepackage{fontspec}
\setmainfont{lmroman10-regular.otf}[
  BoldFont=lmroman10-bold.otf,
  ItalicFont=lmroman10-italic.otf,
  BoldItalicFont=lmroman10-bolditalic.otf,
  Ligatures=NoCommon,
]


%----------FONT OPTIONS----------
% sans-serif
% \usepackage[sfdefault]{FiraSans}
% \usepackage[sfdefault]{roboto}
% \usepackage[sfdefault]{noto-sans}
% \usepackage[default]{sourcesanspro}

% serif
% \usepackage{CormorantGaramond}
% \usepackage{charter}


\pagestyle{fancy}
\fancyhf{} % clear all header and footer fields
\fancyfoot{}
\renewcommand{\headrulewidth}{0pt}
\renewcommand{\footrulewidth}{0pt}

% Adjust margins
\addtolength{\oddsidemargin}{-0.5in}
\addtolength{\evensidemargin}{-0.5in}
\addtolength{\textwidth}{1in}
\addtolength{\topmargin}{-.5in}
\addtolength{\textheight}{1.0in}

\urlstyle{same}

\raggedbottom
\raggedright
\setlength{\tabcolsep}{0in}

% Sections formatting
\titleformat{\section}{
  \vspace{-4pt}\scshape\raggedright\large
}{}{0em}{}[\color{black}\titlerule \vspace{-5pt}]

%-------------------------
% Custom commands
\newcommand{\resumeItem}[1]{
  \item\small{
    {#1 \vspace{-2pt}}
  }
}

\newcommand{\resumeSubheading}[4]{
  \vspace{-2pt}\item
    \begin{tabular*}{0.97\textwidth}[t]{l@{\extracolsep{\fill}}r}
      \textbf{#1} & #2 \\
      \textit{\small#3} & \textit{\small #4} \\
    \end{tabular*}\vspace{-7pt}\nopagebreak
}

\newcommand{\resumeSubSubheading}[2]{
    \item
    \begin{tabular*}{0.97\textwidth}{l@{\extracolsep{\fill}}r}
      \textit{\small#1} & \textit{\small #2} \\
    \end{tabular*}\vspace{-7pt}
}

\newcommand{\resumeProjectHeading}[2]{
    \item
    \begin{tabular*}{0.97\textwidth}{l@{\extracolsep{\fill}}r}
      \small#1 & #2 \\
    \end{tabular*}\vspace{-7pt}\nopagebreak
}

\newcommand{\resumeSubItem}[1]{\resumeItem{#1}\vspace{-4pt}}

\renewcommand\labelitemii{$\vcenter{\hbox{\tiny$\bullet$}}$}

\newcommand{\resumeSubHeadingListStart}{\begin{itemize}[leftmargin=0.15in, label={}]}
\newcommand{\resumeSubHeadingListEnd}{\end{itemize}}
% beginpenalty forbids a page break between an entry's heading and its first
% bullet. Without it a heading can be the last thing on a page and its bullets
% the first thing on the next — which is how "Founder & Digital Creator / Kudi
% Kitchen" ended one page with its only bullet starting the next. enumitem is
% already loaded above, so this costs no new package: the compile service has
% no network during a compile and could not fetch one.
\newcommand{\resumeItemListStart}{\begin{itemize}[beginpenalty=10000]}
\newcommand{\resumeItemListEnd}{\end{itemize}\vspace{-5pt}}

%-------------------------------------------
%%%%%%  RESUME STARTS HERE  %%%%%%%%%%%%%%%%%%%%%%%%%%%%
`;

// SECURITY-CRITICAL (ADR 0002): user content must never inject LaTeX commands.
// A single-pass replacement maps each special independently, so backslash is
// effectively handled "first" — its \textbackslash{} output cannot be
// re-escaped by a later brace rule, the trap a sequential replace chain falls
// into. Handles undefined/empty by returning ''.
const LATEX_ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

export function escapeLatex(s: string): string {
  if (!s) return '';
  return s.replace(/[\\&%$#_{}~^]/g, (ch) => LATEX_ESCAPES[ch]);
}

/**
 * What a link is called on the page.
 *
 * A resume shows "GitHub", not "https://github.com/someone/some-repo". The long
 * form eats a line of horizontal space and is unusable on paper, where nobody
 * is going to type it out.
 */
export function linkLabel(url: string): string {
  const host = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  const known: Record<string, string> = {
    'github.com': 'GitHub',
    'gitlab.com': 'GitLab',
    'linkedin.com': 'LinkedIn',
    'medium.com': 'Medium',
    'devpost.com': 'Devpost',
  };
  return known[host] ?? host ?? url;
}

/** \\href needs a scheme or the link is relative and silently dead. */
export function withScheme(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// Heading contact line: joins present fields with ` $|$ `. Emails/links are
// wrapped in \href{...}{\underline{...}} like the Jake Gutierrez template.
function renderContact(c: ResumeStructure['contact']): string {
  const parts: string[] = [];
  if (c.phone) parts.push(escapeLatex(c.phone));
  if (c.email) parts.push(`\\href{mailto:${escapeLatex(c.email)}}{\\underline{${escapeLatex(c.email)}}}`);
  // Labelled, not spelled out. A resume header says "LinkedIn", not
  // "https://linkedin.com/in/chukwudi-ndubuisi-1a2b3c" — the long form eats the
  // line and is useless on paper, where nobody retypes it.
  for (const link of [c.linkedin, c.github, c.website]) {
    if (link) parts.push(`\\href{${escapeLatex(withScheme(link))}}{\\underline{${escapeLatex(linkLabel(link))}}}`);
  }
  return parts.join(' $|$ ');
}

/**
 * A section is omitted entirely when it has nothing in it.
 *
 * Not cosmetic. Both list macros open an `itemize`, and LaTeX refuses to
 * typeset an `itemize` containing no `\item` — "Something's wrong--perhaps a
 * missing \item" — which aborts the whole compile. So an account with no
 * projects yet, or a job whose bullets have not been written, produced no PDF
 * at all rather than a PDF without that section.
 *
 * Printing an empty heading would be wrong anyway: a resume with the word
 * "Projects" and nothing under it reads worse than one that never mentions it.
 */
export function renderResumeLatex(r: ResumeStructure): string {
  const lines: string[] = [];

  // Heading
  lines.push('\\begin{center}');
  lines.push(`    \\textbf{\\Huge \\scshape ${escapeLatex(r.name)}} \\\\ \\vspace{1pt}`);
  lines.push(`    \\small ${renderContact(r.contact)}`);
  lines.push('\\end{center}');

  /** Bullets under one entry, or nothing at all when there are none yet. */
  const pushBullets = (bullets: string[]) => {
    if (!bullets.length) return;
    lines.push('      \\resumeItemListStart');
    for (const b of bullets) {
      lines.push(`        \\resumeItem{${escapeLatex(b)}}`);
    }
    lines.push('      \\resumeItemListEnd');
  };

  const heading = (label: string) => {
    lines.push('');
    lines.push(`\\section{${escapeLatex(label)}}`);
  };

  // Drawn by SHAPE, not by name.
  //
  // This used to be four functions keyed by 'education' | 'experience' |
  // 'projects' | 'skills', with the summary hardcoded above the loop and
  // certifications and awards hardcoded below it — which is why a section the
  // app did not have a name for could not be drawn at all, and why the summary
  // could never move. There were never seven ways to draw a section; there were
  // five, used seven times. Now that is what the code says, and a Volunteering
  // section is not a new renderer, it is `entries` with a different heading.
  //
  // Every branch is guarded by hasContent before it runs. That is not tidiness:
  // an `itemize` with no `\item` in it aborts the whole compile, so an empty
  // section is a failed PDF rather than a blank space.
  for (const section of planSections(r)) {
    const content = contentFor(r, section);
    if (!hasContent(content)) continue;

    heading(section.label);

    switch (content.shape) {
      case 'prose':
        lines.push(`\\small{${escapeLatex(content.text)}}`);
        break;

      case 'entries':
        lines.push('  \\resumeSubHeadingListStart');
        for (const e of content.entries) {
          // The link rides on the second line beside the organisation, which is
          // where a certificate's issuer and its Verify link belong together.
          // The heading cell is already carrying a date and does not wrap.
          const link = e.url
            ? `\\href{${escapeLatex(withScheme(e.url))}}{\\underline{${escapeLatex(linkLabel(e.url))}}}`
            : '';
          const sub = [escapeLatex(e.sub), link].filter(Boolean).join(' $|$ ');
          lines.push(
            `    \\resumeSubheading{${escapeLatex(e.heading)}}{${escapeLatex(e.headingRight)}}{${sub}}{${escapeLatex(e.subRight)}}`,
          );
          pushBullets(e.bullets);
        }
        lines.push('  \\resumeSubHeadingListEnd');
        break;

      case 'inline':
        lines.push('  \\resumeSubHeadingListStart');
        for (const p of content.entries) {
          // Without tech the separator would dangle after the name.
          const parts = [`\\textbf{${escapeLatex(p.name)}}`];
          if (p.tech) parts.push(`\\emph{${escapeLatex(p.tech)}}`);
          // A short label, never the URL. The heading cell does not wrap, so a
          // full link pushed the dates past the right margin and clipped them
          // off the page entirely.
          if (p.url) parts.push(`\\href{${escapeLatex(withScheme(p.url))}}{\\underline{${escapeLatex(linkLabel(p.url))}}}`);
          lines.push(`    \\resumeProjectHeading{${parts.join(' $|$ ')}}{${escapeLatex(p.dates)}}`);
          pushBullets(p.bullets);
        }
        lines.push('  \\resumeSubHeadingListEnd');
        break;

      case 'groups': {
        lines.push(' \\begin{itemize}[leftmargin=0.15in, label={}]');
        // A dangling colon is the tell that a form let something through
        // half-filled. "English" with no level prints as itself; a value with
        // no label prints as itself. Only both together take the separator.
        const groupLines = content.groups
          .map((s) => {
            const body = s.category && s.items
              ? `\\textbf{${escapeLatex(s.category)}}{: ${escapeLatex(s.items)}}`
              : s.category
                ? `\\textbf{${escapeLatex(s.category)}}`
                : escapeLatex(s.items);
            return `     ${body} \\\\`;
          })
          .join('\n');
        lines.push(`    \\small{\\item{\n${groupLines}\n    }}`);
        lines.push(' \\end{itemize}');
        break;
      }

      case 'list':
        lines.push('  \\resumeItemListStart');
        for (const item of content.items) {
          lines.push(`    \\resumeItem{${escapeLatex(item)}}`);
        }
        lines.push('  \\resumeItemListEnd');
        break;
    }
  }

  const body = lines.join('\n');
  return PREAMBLE + '\n\\begin{document}\n' + body + '\n\\end{document}\n';
}
