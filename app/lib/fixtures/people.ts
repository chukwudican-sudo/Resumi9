import type { ResumeStructure } from '../types';

/**
 * Profiles that are not the author's.
 *
 * Every acceptance check the app had was written against one real account —
 * one student, one degree, one set of employers, a one-page rule — and the
 * checks named them: "Celestica B&P keeps Western Bell", "Intel lists Digital
 * Systems", `/Apr 2028/`. That suite cannot fail for anybody else, because
 * nobody else is in it, and a regression that only shows on a two-page senior
 * resume or a profile with no projects at all would pass every test and ship.
 *
 * So these exist. They are invented, deliberately varied along the axes the
 * pipeline actually branches on, and none of them is anybody real:
 *
 *   - how many entries there are, and whether a section is near its floor
 *   - whether there are projects at all, or a tech line to rank them by
 *   - how long the page rule is
 *   - whether the work is technical, so a posting's words are tool names, or
 *     not, so they are prose and nothing matches exactly
 *   - whether two entries answer to one name
 *   - how companies are spelled: suffixes, non-English places, punctuation
 *
 * Postings are stored beside each person rather than crossed with everybody,
 * because a posting is only a fair test against a profile that could plausibly
 * apply to it. Each person carries two, so every invariant is checked at least
 * twice per shape.
 */

export interface Person {
  /** Short id for test output. */
  readonly name: string;
  /** What this profile is here to exercise, in one line. */
  readonly tests: string;
  readonly profile: ResumeStructure;
  /** As `getActiveRules` returns them. */
  readonly rules: readonly { id: string; text: string; check: unknown }[];
  readonly postings: readonly { role: string; text: string }[];
}

const onePage = { id: 'r1', text: 'Keep the resume one page', check: { kind: 'max_pages', limit: 1 } };
const twoPages = { id: 'r1', text: 'Two pages is fine', check: { kind: 'max_pages', limit: 2 } };

export const PEOPLE: readonly Person[] = [
  {
    name: 'swe-student',
    tests: 'the common case: several projects with tech lines, one internship, a one-page rule',
    profile: {
      name: 'Priya Raman',
      contact: { email: 'p@example.com', phone: '555-0100' },
      education: [
        { school: 'University of Waterloo', location: 'Waterloo, ON', degree: 'BASc Computer Engineering', dates: 'Sep 2023 – Apr 2028 (Expected)', bullets: ['Relevant coursework: Data Structures, Operating Systems'] },
      ],
      experience: [
        { title: 'Software Engineering Intern', org: 'Northwind Systems', location: 'Toronto, ON', dates: 'May 2026 – Aug 2026', bullets: ['Shipped a caching layer that cut median response time from 400ms to 90ms', 'Wrote the migration that moved 2.1M rows without downtime', 'Added read-through caching behind a feature flag so it could be turned off under load', 'Documented the invalidation rules after a stale-cache incident in week three'] },
        { title: 'Teaching Assistant', org: 'University of Waterloo', location: 'Waterloo, ON', dates: 'Sep 2025 – Apr 2026', bullets: ['Ran weekly tutorials for 60 students in a first-year programming course', 'Marked 400+ assignments against a shared rubric', 'Rewrote two lab handouts after tracking where students got stuck', 'Held office hours that two thirds of the section used at least once'] },
        { title: 'Web Developer (Part-time)', org: 'Grand River Cycling', location: 'Kitchener, ON', dates: 'May 2025 – Aug 2025', bullets: ['Rebuilt the booking page and cut abandoned bookings by a fifth', 'Moved the site to static hosting, dropping the monthly bill to nothing', 'Set up uptime alerting after a silent outage went unnoticed for a day'] },
      ],
      projects: [
        { name: 'Tideline', tech: 'TypeScript, Next.js, PostgreSQL', dates: 'Jun 2026 – Present', bullets: ['Built a tide-prediction site serving 40 coastal stations', 'Cached station reads so a page costs one query instead of forty', 'Backfilled eleven years of readings without blocking live traffic', 'Published the station data as an open JSON feed with a documented schema'] },
        { name: 'Quorum', tech: 'Python, FastAPI, pytest', dates: 'Jan 2026 – Apr 2026', bullets: ['Compared three consensus algorithms under induced packet loss', 'Covered the state machine with a 40-test pytest suite', 'Wrote up where each algorithm failed and why', 'Ran each algorithm against the same recorded loss trace so results were comparable'] },
        { name: 'Blackbird', tech: 'Rust, WebAssembly', dates: 'Aug 2025', bullets: ['Ported an image filter to WebAssembly, 6x faster than the JS version', 'Traded 300KB of binary size for the speed and documented the choice'] },
        { name: 'Study Deck', tech: 'React Native, Expo', dates: '2025', bullets: ['Spaced-repetition flashcards with offline sync', 'Resolved edit conflicts by last-write-wins per card rather than per deck'] },
      ],
      skills: [
        { category: 'Languages', items: 'TypeScript, Python, Rust, SQL, C' },
        { category: 'Web', items: 'React, Next.js, Node.js, REST API Design' },
        { category: 'Data', items: 'PostgreSQL, Redis, Pandas' },
        { category: 'Tools', items: 'Git, Docker, pytest, GitHub Actions (CI/CD)' },
      ],
    },
    rules: [onePage],
    postings: [
      { role: 'Backend Engineering Intern', text: 'Backend engineering internship. We work in Python and FastAPI, with PostgreSQL behind a REST API. You will write tests — pytest — and ship through GitHub Actions. Experience with caching and query performance is valued.' },
      { role: 'Frontend Engineering Intern', text: 'Frontend internship building customer-facing web applications in React and Next.js with TypeScript. You will care about page load time and accessibility.' },
    ],
  },

  {
    name: 'non-tech',
    tests: 'no projects section at all, and a posting whose words are prose rather than tool names',
    profile: {
      name: 'Daniel Okafor',
      contact: { email: 'd@example.com' },
      education: [
        { school: 'Carleton University', location: 'Ottawa, ON', degree: 'BA Communications', dates: 'Sep 2021 – Jun 2025', bullets: [] },
      ],
      experience: [
        { title: 'Marketing Coordinator', org: 'Harbour & Finch', location: 'Ottawa, ON', dates: 'Jul 2025 – Present', bullets: ['Grew the newsletter from 3,000 to 11,000 subscribers in ten months', 'Ran the editorial calendar across four channels', 'Briefed three freelance writers and edited their copy before publication'] },
        { title: 'Communications Assistant', org: 'Ottawa Food Bank', location: 'Ottawa, ON', dates: 'Sep 2024 – Jun 2025', bullets: ['Wrote 40+ donor updates and the annual impact report', 'Coordinated volunteer messaging for two seasonal campaigns', 'Kept the media list current through a change of leadership'] },
        { title: 'Barista', org: 'Second Cup', location: 'Ottawa, ON', dates: 'Jun 2023 – Aug 2024', bullets: ['Served a morning rush of 200+ customers with a two-person team', 'Trained four new staff on the opening routine', 'Cut waste by reworking how pastries were ordered midweek'] },
        { title: 'Student Newspaper Editor', org: 'The Charlatan', location: 'Ottawa, ON', dates: 'Sep 2022 – Apr 2024', bullets: ['Edited a weekly section across two years of print and web', 'Commissioned and scheduled work from twelve contributors', 'Introduced a style guide that cut repeat corrections'] },
      ],
      projects: [],
      skills: [
        { category: 'Communications', items: 'Copywriting, Editing, Press Releases, Internal Comms' },
        { category: 'Tools', items: 'Mailchimp, Canva, Google Analytics, Hootsuite' },
      ],
    },
    rules: [onePage],
    postings: [
      { role: 'Communications Officer', text: 'You will own donor communications: newsletters, campaign messaging and the annual report. Strong writing and editing. Comfortable briefing freelancers and holding an editorial calendar.' },
      { role: 'Social Media Manager', text: 'Plan and publish across channels, measure what works, and grow the audience. Analytics literacy expected.' },
    ],
  },

  {
    name: 'career-changer',
    tests: 'old unrelated work above new relevant work, so recency and relevance disagree',
    profile: {
      name: 'Mariela Santos',
      contact: { email: 'm@example.com' },
      education: [
        { school: 'Seneca Polytechnic', location: 'Toronto, ON', degree: 'Certificate, Data Analytics', dates: 'Jan 2026 – Aug 2026', bullets: ['Capstone: hospital readmission modelling'] },
        { school: 'Universidad de Sevilla', location: 'Sevilla, Spain', degree: 'Diplomatura en Enfermería', dates: 'Sep 2012 – Jun 2015', bullets: [] },
      ],
      experience: [
        { title: 'Data Analyst (Contract)', org: 'Riverbend Health', location: 'Toronto, ON', dates: 'Sep 2026 – Present', bullets: ['Built the weekly bed-occupancy dashboard used by three unit managers', 'Cleaned and reconciled 18 months of admission records across two systems', 'Wrote the data dictionary the unit managers now check before asking'] },
        { title: 'Registered Nurse', org: 'Hospital Virgen del Rocío', location: 'Sevilla, Spain', dates: 'Aug 2015 – Nov 2025', bullets: ['Coordinated discharge planning for a 32-bed ward', 'Trained 14 incoming nurses on medication reconciliation', 'Kept medication records accurate across three daily handovers', 'Sat on the ward committee that rewrote the handover template', 'Audited six months of charts after a near-miss and reported the pattern'] },
      ],
      projects: [
        { name: 'Readmission Risk', tech: 'Python, pandas, scikit-learn', dates: 'Jun 2026 – Aug 2026', bullets: ['Modelled 30-day readmission on 9,000 anonymised records', 'Reported which features the model actually leaned on', 'Held out a full quarter rather than splitting at random, because admissions are seasonal'] },
        { name: 'Ward Rota', tech: 'SQL, Excel', dates: 'Mar 2026', bullets: ['Rebuilt a hand-kept staffing rota as a query over the shift table', 'Found 140 hours a year lost to double-booked handovers'] },
        { name: 'Triage Times', tech: 'Python, matplotlib', dates: 'Feb 2026', bullets: ['Charted waiting times by hour across four months of A&E data'] },
      ],
      skills: [
        { category: 'Analysis', items: 'SQL, Python, pandas, Excel' },
        { category: 'Clinical', items: 'Discharge Planning, Medication Reconciliation, Patient Education' },
      ],
    },
    rules: [onePage],
    postings: [
      { role: 'Healthcare Data Analyst', text: 'Analyst role in a hospital network. SQL and Python. You will build dashboards for clinical managers and reconcile records across systems. Clinical background an asset.' },
      { role: 'Junior Business Analyst', text: 'Work with stakeholders to turn operational questions into reports. Excel and SQL. Attention to detail and clear written communication.' },
    ],
  },

  {
    name: 'senior-two-page',
    tests: 'a two-page rule, six jobs, and far more content than one page can hold',
    profile: {
      name: 'Thomas Ikeda',
      contact: { email: 't@example.com' },
      education: [
        { school: 'McGill University', location: 'Montréal, QC', degree: 'BEng Electrical Engineering', dates: 'Sep 2008 – May 2012', bullets: [] },
      ],
      experience: [
        { title: 'Principal Engineer', org: 'Lumen Grid', location: 'Montréal, QC', dates: 'Mar 2022 – Present', bullets: ['Led the replatforming of a metering service handling 4M readings a day', 'Set the on-call rotation and cut paging volume by 60%', 'Mentored six engineers through promotion', 'Ran the incident review process and published every write-up internally', 'Moved the service onto a schema that survives a meter firmware change', 'Held the error budget through two regional outages'] },
        { title: 'Staff Engineer', org: 'Vantage Power Systems', location: 'Toronto, ON', dates: 'Jan 2019 – Feb 2022', bullets: ['Designed the telemetry pipeline behind the fleet dashboard', 'Took the deploy from fortnightly to daily', 'Introduced contract tests between the pipeline and three downstream teams', 'Cut the nightly batch window from six hours to ninety minutes', 'Wrote the runbook that let the on-call rotation widen to eight people'] },
        { title: 'Senior Software Engineer', org: 'Corvus Analytics', location: 'Toronto, ON', dates: 'Jun 2016 – Dec 2018', bullets: ['Rewrote the batch scheduler, halving overnight run time', 'Introduced the first integration test suite', 'Migrated 40 cron jobs onto the scheduler and retired the crontab', 'Paid down the retry logic that had been silently dropping work'] },
        { title: 'Software Engineer', org: 'Marchetti & Sons Ltd.', location: 'Toronto, ON', dates: 'Aug 2014 – May 2016', bullets: ['Built the customer billing exports still in use', 'Reconciled two billing systems during an acquisition', 'Automated the month-end export that had been run by hand'] },
        { title: 'Embedded Developer', org: 'Northline Instruments', location: 'Ottawa, ON', dates: 'Jul 2012 – Jul 2014', bullets: ['Wrote firmware for a handheld field meter', 'Cut the calibration routine from twelve steps to four'] },
        { title: 'Engineering Intern', org: 'Hydro-Québec', location: 'Montréal, QC', dates: 'May 2011 – Aug 2011', bullets: ['Instrumented a substation test bench'] },
      ],
      projects: [
        { name: 'Ledgerline', tech: 'Go, Postgres', dates: '2024', bullets: ['Open-source double-entry ledger, 900 stars'] },
      ],
      skills: [
        { category: 'Languages', items: 'Go, Python, C++, SQL' },
        { category: 'Infrastructure', items: 'Kubernetes, Terraform, Prometheus, Kafka' },
        { category: 'Practices', items: 'On-call, Incident Review, Mentoring, Design Review' },
      ],
    },
    rules: [twoPages],
    postings: [
      { role: 'Engineering Manager, Platform', text: 'Lead a platform team. You have run on-call, mentored engineers and owned a service at scale. Go or Python. Kubernetes.' },
      { role: 'Staff Backend Engineer', text: 'Deep backend work on high-throughput data pipelines. Kafka, Postgres, Go. You will set technical direction.' },
    ],
  },

  {
    name: 'international',
    tests: 'company suffixes, non-English place names and punctuation in names',
    profile: {
      name: 'Chidera Nwosu-Bell',
      contact: { email: 'c@example.com' },
      education: [
        { school: 'University of Lagos', location: 'Lagos, Nigeria', degree: 'BSc Industrial Engineering', dates: 'Oct 2019 – Jul 2023', bullets: [] },
      ],
      experience: [
        { title: 'Operations Analyst', org: 'Grüner Logistik GmbH', location: 'München, Germany', dates: 'Feb 2025 – Present', bullets: ['Cut average dwell time at two depots from 41 to 26 hours', 'Rebuilt the weekly load plan around actual vehicle availability', 'Reconciled carrier invoices against the manifest and recovered a quarter of overbilling'] },
        { title: 'Supply Chain Officer', org: 'Adeyemi Holdings Ltd.', location: 'Port Harcourt, Nigeria', dates: 'Aug 2023 – Jan 2025', bullets: ['Tracked procurement and inventory for 200+ industrial units across partners', 'Kept stock records reconciled against supplier invoices monthly', 'Negotiated three framework agreements with local carriers', 'Cut emergency orders by a third by setting reorder points from real consumption', 'Ran the monthly stock count across two warehouses'] },
        { title: 'Intern, Plant Operations', org: 'Sunrise Foods Pvt Ltd', location: 'Pune, India', dates: 'Jun 2022 – Aug 2022', bullets: ['Timed the bottling line and found a 12-minute changeover saving'] },
      ],
      projects: [
        { name: 'Routeplan', tech: 'Python, OR-Tools', dates: '2024', bullets: ['Solved a 40-stop vehicle routing problem for a volunteer delivery group', 'Cut the modelled distance by 19% against the hand-drawn route'] },
        { name: 'Stockwatch', tech: 'Excel, Power Query', dates: '2023', bullets: ['Built a reorder-point model over two years of consumption data', 'Flagged eleven lines that had been reordered on habit rather than need'] },
        { name: 'Depot Times', tech: 'Power BI', dates: '2025', bullets: ['Dashboarded dwell time by depot, shift and carrier'] },
      ],
      skills: [
        { category: 'Supply Chain', items: 'Procurement, Inventory Control, Demand Planning, Vendor Management' },
        { category: 'Tools', items: 'SAP MM, Excel, Power BI, Python' },
      ],
    },
    rules: [onePage],
    postings: [
      { role: 'Supply Chain Analyst', text: 'Analyst supporting procurement and inventory across a distribution network. SAP experience valued. You will reconcile stock records and work with vendors.' },
      { role: 'Logistics Coordinator', text: 'Coordinate carriers and depot schedules. Excel strong. Experience reducing dwell time or improving load planning.' },
    ],
  },

  {
    name: 'duplicate-venture',
    tests: 'one venture written up as both a job and a project, which is a real shape and not a bug',
    profile: {
      name: 'Rosa Lindqvist',
      contact: { email: 'r@example.com' },
      education: [
        { school: 'Toronto Metropolitan University', location: 'Toronto, ON', degree: 'BComm', dates: 'Sep 2022 – Apr 2026', bullets: [] },
      ],
      experience: [
        { title: 'Founder', org: 'Pepperbox', location: 'Toronto, ON', dates: 'Mar 2024 – Present', bullets: ['Took a spice subscription from nothing to 320 recurring customers', 'Ran fulfilment, support and the supplier relationships myself', 'Held churn under 4% a month through the second year'] },
        { title: 'Retail Supervisor', org: 'Harlow Goods', location: 'Toronto, ON', dates: 'May 2023 – Feb 2024', bullets: ['Supervised a four-person floor team through two holiday seasons', 'Cut stock discrepancies by recounting high-shrink lines weekly', 'Rebuilt the opening and closing checklists after a cash-handling error', 'Covered buying for two categories while the buyer was on leave'] },
        { title: 'Sales Associate', org: 'Birchway Outfitters', location: 'Barrie, ON', dates: 'Jun 2022 – Apr 2023', bullets: ['Hit 118% of quarterly target twice'] },
      ],
      projects: [
        { name: 'Pepperbox', tech: 'Shopify, Klaviyo, HTML/CSS', dates: '2024', bullets: ['Hand-built the storefront and the subscription checkout', 'Set up the lifecycle email flows that carry a third of reorders', 'Moved the subscription logic off a plugin that kept breaking on renewals'] },
        { name: 'Shelftalk', tech: 'Figma', dates: '2025', bullets: ['Designed in-store signage trialled across six independent grocers', 'Tested two layouts against till data over a fortnight'] },
        { name: 'Reorder', tech: 'Excel, Shopify API', dates: '2025', bullets: ['Pulled Shopify sales into a reorder sheet that replaced a weekly guess', 'Cut stockouts on the ten best-selling lines'] },
        { name: 'Cardstock', tech: 'Figma, Illustrator', dates: '2024', bullets: ['Designed the packaging run for a 320-subscriber launch'] },
      ],
      skills: [
        { category: 'Commerce', items: 'E-commerce, Subscription Retail, Inventory, Customer Support' },
        { category: 'Tools', items: 'Shopify, Klaviyo, Figma, Excel' },
      ],
    },
    rules: [onePage],
    postings: [
      { role: 'E-commerce Coordinator', text: 'Own the storefront day to day: merchandising, lifecycle email, and the subscription flow. Shopify and Klaviyo.' },
      { role: 'Retail Operations Associate', text: 'Support store operations, inventory accuracy and the floor team. Experience reducing shrink is valued.' },
    ],
  },

  {
    name: 'sparse',
    tests: 'a profile already at every floor, where nothing may be cut at all',
    profile: {
      name: 'Owen Pratt',
      contact: { email: 'o@example.com' },
      education: [
        { school: 'Durham College', location: 'Oshawa, ON', degree: 'Diploma, Computer Programming', dates: 'Sep 2025 – Apr 2027', bullets: [] },
      ],
      experience: [
        { title: 'IT Support Assistant', org: 'Oshawa Public Library', location: 'Oshawa, ON', dates: 'Jan 2026 – Present', bullets: ['Reimaged 40 public terminals and wrote the runbook for it', 'Closed 300+ helpdesk tickets in the first six months'] },
      ],
      projects: [
        { name: 'Shiftly', tech: 'JavaScript, Firebase', dates: '2026', bullets: ['Shift-swap board for a 20-person retail team'] },
      ],
      skills: [{ category: 'Technical', items: 'JavaScript, HTML/CSS, Windows, Ticketing' }],
    },
    rules: [onePage],
    postings: [
      { role: 'IT Support Analyst', text: 'Frontline support for staff devices and printers. Windows imaging, ticketing, and clear written handovers.' },
      { role: 'Junior Developer', text: 'Entry-level development in JavaScript. You will work on internal tools.' },
    ],
  },

  {
    name: 'many-skills',
    tests: 'more skills lines than the cap allows, so the cap has to choose',
    profile: {
      name: 'Aisha Brahimi',
      contact: { email: 'a@example.com' },
      education: [
        { school: 'Concordia University', location: 'Montréal, QC', degree: 'BSc Computer Science', dates: 'Sep 2022 – Apr 2026', bullets: ['Relevant coursework: Machine Learning, Databases'] },
      ],
      experience: [
        { title: 'Machine Learning Intern', org: 'Perihelion Labs', location: 'Montréal, QC', dates: 'May 2026 – Aug 2026', bullets: ['Cut inference latency 3x by quantising the serving model', 'Built the evaluation harness the team still runs nightly', 'Found a label leak that had been flattering the baseline for months'] },
        { title: 'Research Assistant', org: 'Concordia University', location: 'Montréal, QC', dates: 'Sep 2025 – Apr 2026', bullets: ['Reproduced three published baselines and documented where they differed', 'Maintained the lab GPU scheduling scripts', 'Wrote the data loader the lab standardised on', 'Caught a preprocessing mismatch that explained a year of odd results'] },
      ],
      projects: [
        { name: 'Thresher', tech: 'PyTorch, CUDA', dates: '2026', bullets: ['Trained a small vision model end to end on one GPU', 'Cut training time in half by fixing a data loader that was starving the GPU', 'Logged every run so the best checkpoint could be traced to its config'] },
        { name: 'Corpusline', tech: 'Python, DuckDB', dates: '2025', bullets: ['Deduplicated a 4M-document corpus in under an hour', 'Chose MinHash over exact matching after measuring both on a sample'] },
        { name: 'Benchpress', tech: 'Python, Slurm', dates: '2025', bullets: ['Queued and collected 200 training runs across a shared cluster', 'Made every run reproducible from a single config hash'] },
      ],
      skills: [
        { category: 'Languages', items: 'Python, C++, SQL, Julia' },
        { category: 'ML', items: 'PyTorch, scikit-learn, Hugging Face, ONNX' },
        { category: 'Data', items: 'DuckDB, Parquet, Pandas, Polars' },
        { category: 'Infrastructure', items: 'Docker, Slurm, CUDA, Linux' },
        { category: 'Maths', items: 'Linear Algebra, Probability, Optimisation' },
        { category: 'Practices', items: 'Experiment Tracking, Reproducibility, Code Review' },
        { category: 'Writing', items: 'Technical Documentation, Literature Review' },
      ],
    },
    rules: [onePage],
    postings: [
      { role: 'ML Engineering Intern', text: 'Serve models in production. PyTorch, ONNX, Docker. You will care about inference latency and evaluation.' },
      { role: 'Data Engineering Intern', text: 'Build data pipelines over large document corpora. Python, DuckDB, Parquet.' },
    ],
  },
];
