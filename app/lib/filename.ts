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

/** Live-sanitizes user input in the editable filename field (base name only, no ".pdf"). */
export function sanitizeFilenameInput(value: string): string {
  return value
    .replace(SPECIAL_CHARS_REGEX, '')
    .replace(/\s+/g, '_')
    .slice(0, FILENAME_MAX_BASE_LENGTH);
}
