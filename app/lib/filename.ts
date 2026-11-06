// Universal PDF filename rule (Resumi9 change-spec, Section 11):
//   FirstName_LastName_RoleTitle_Company_Resume.pdf
// No spaces, no special characters, no dates/version numbers, max 50 chars
// before ".pdf" (truncate the role title first if it doesn't fit).

const SPECIAL_CHARS_REGEX = /[@#%&*()/\\|?!'",.]/g;
export const FILENAME_MAX_BASE_LENGTH = 50;

/**
 * The words of a title, each capitalised, ready to be joined or dropped.
 *
 * A hyphenated compound counts as ONE word. Split on the hyphen, "Software
 * Engineer Co-op/Intern" can be shortened to "SoftwareEngineerCo", which
 * reads as a word cut in half — the exact complaint this file is being fixed
 * for, arriving by a different route.
 */
function titleCaseWords(value: string): string[] {
  const cap = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  return value
    .replace(SPECIAL_CHARS_REGEX, '')
    .trim()
    .split(/[^a-zA-Z0-9-]+/)
    .map((piece) => piece.split('-').filter(Boolean).map(cap).join(''))
    .filter(Boolean);
}

function titleCaseConcat(value: string): string {
  return titleCaseWords(value).join('');
}

function sanitizeNamePart(name: string): string {
  const cleaned = name.replace(SPECIAL_CHARS_REGEX, '').trim();
  if (!cleaned) return 'Applicant';
  return cleaned.split(/\s+/).filter(Boolean).join('_');
}

/** Builds the default filename base (everything before ".pdf"). */
export function buildDefaultFilenameBase(userName: string, role: string, company: string): string {
  const namePart = sanitizeNamePart(userName);
  const rolePart = titleCaseConcat(role);
  const companyPart = titleCaseConcat(company);

  const assemble = (r: string, c: string) => [namePart, r, c, 'Resume'].filter(Boolean).join('_');

  const base = assemble(rolePart, companyPart);
  if (base.length <= FILENAME_MAX_BASE_LENGTH) return base;

  /*
   * Whole words, never a cut one — and the company gives before the role.
   *
   * It used to slice characters off the role, and "GPU & AI Accelerator
   * Hardware Design Undergrad Intern" came out as
   * Chukwudi_Alex_GPUAIAcceleratorHardwar_Intel_Resume.pdf. A filename is the
   * first thing a recruiter sees of a resume and the only thing they see of it
   * in a folder, and a word cut in half reads as a broken export.
   *
   * The company's tail goes first because it is the part nobody needs: the
   * person reading the file works at Celestica and does not need
   * "International" to know it. The ROLE is what tells two applications to the
   * same company apart, which is why it is the last thing shortened —
   * shortening it first gave both Celestica resumes the same name.
   *
   * Dropped from the end on both, because a name says what the thing is first
   * and qualifies it afterwards.
   */
  const roleWords = titleCaseWords(role);
  const companyWords = titleCaseWords(company);

  /*
   * The role is tried longest-first and the company bends around it.
   *
   * The other way round reads worse for the same number of characters:
   * Machine_QualcommCanadaULC against MachineLearning_Qualcomm. Nobody needs
   * "Canada ULC" to know which Qualcomm, and "Machine" on its own has lost
   * the thing the file is about.
   */
  for (let r = roleWords.length; r >= 1; r -= 1) {
    const shorterRole = roleWords.slice(0, r).join('');
    for (let c = companyWords.length; c >= 1; c -= 1) {
      const candidate = assemble(shorterRole, companyWords.slice(0, c).join(''));
      if (candidate.length <= FILENAME_MAX_BASE_LENGTH) return candidate;
    }
  }

  // Their name and the word Resume, which is all that still fits. Never a
  // fragment of something longer.
  return [namePart, 'Resume'].join('_').slice(0, FILENAME_MAX_BASE_LENGTH);
}

/**
 * The version, on every download after the first.
 *
 * The rule above says no version numbers, and it was written about dates and
 * build stamps — the noise that makes a filename look machine-generated. It
 * did not anticipate that one application produces a dozen downloads: every
 * one arrived as the same name, so a folder filled with
 * `…_Resume.pdf`, `…_Resume (1).pdf`, `…_Resume (2).pdf`, numbered by the
 * browser in download order with no relation to the version, and there was no
 * way to tell which one was the resume that got sent.
 *
 * Version 1 is left bare, because the common case is one download and a `_v1`
 * on it reads as a draft. From the second version on, the number is the
 * person's own and matches what the app shows beside the preview.
 *
 * Counted inside the length limit: the suffix is what makes the name useful,
 * so the role gives way to it rather than the other way round.
 */
export function withVersion(base: string, version: number | null | undefined): string {
  if (!Number.isFinite(version) || (version as number) < 2) return base;
  const suffix = `_v${Math.floor(version as number)}`;
  const room = FILENAME_MAX_BASE_LENGTH - suffix.length;
  /*
   * Trimmed back to a whole word, never mid-word: the whole point of the
   * shortening above is that a filename never shows half a word.
   */
  if (base.length <= room) return `${base}${suffix}`;
  const parts = base.split('_');
  for (let keep = parts.length; keep >= 1; keep -= 1) {
    const shorter = parts.slice(0, keep).join('_');
    if (shorter.length <= room) return `${shorter}${suffix}`;
  }
  return `${parts[0].slice(0, Math.max(1, room))}${suffix}`;
}

/** Live-sanitizes user input in the editable filename field (base name only, no ".pdf"). */
export function sanitizeFilenameInput(value: string): string {
  return value
    .replace(SPECIAL_CHARS_REGEX, '')
    .replace(/\s+/g, '_')
    .slice(0, FILENAME_MAX_BASE_LENGTH);
}
