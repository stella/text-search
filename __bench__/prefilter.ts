/**
 * Benchmark: Hyperscan-inspired prefiltered vs baseline.
 *
 * Tests across different corpus densities:
 * - Dense: every paragraph has matches (worst case)
 * - Sparse: 5% of text has matches (real-world legal)
 * - Very sparse: 1% of text has matches (large doc)
 *
 * Approaches:
 * 1. Baseline: all regex patterns in RegexSet, full scan
 * 2. Current: TextSearch routing (AC literals + RegexSet)
 * 3. Prefiltered: AC pre-filter + RegexSet on regions
 * 4. AC-only: pure literal search (upper bound)
 * 5. RegexSet-only: regex patterns only
 */

import { AhoCorasick } from "@stll/aho-corasick";
import { RegexSet } from "@stll/regex-set";

import { PrefilteredEngine } from "../src/prefilter";
import { TextSearch } from "../src/text-search";

// ─── Test patterns ─────────────────────────────────

const LEGAL_PATTERNS = [
  "IČO:\\s*\\d{8}",
  "DIČ:\\s*CZ\\d{8,10}",
  "rodné číslo:\\s*\\d{6}/\\d{3,4}",
  "datum narození:\\s*\\d{1,2}\\.\\s*\\d{1,2}\\.\\s*\\d{4}",
  "č\\.\\s*j\\.:\\s*[A-Z0-9/-]+",
  "sp\\.\\s*zn\\.:\\s*\\d+\\s*[A-Z]+\\s*\\d+/\\d+",
  "(?:Ing|Mgr|JUDr|MUDr|PhDr|RNDr|Bc)\\.\\s+[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][a-záčďéěíňóřšťúůýž]+",
  "\\d{1,2}\\.\\s*\\d{1,2}\\.\\s*\\d{4}",
  "\\+?\\d{3}\\s?\\d{3}\\s?\\d{3}\\s?\\d{3}",
  "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}",
];

const LITERAL_PATTERNS = [
  "společnost s ručením omezeným",
  "akciová společnost",
  "obchodní rejstřík",
  "Městský soud v Praze",
  "Krajský soud v Brně",
  "živnostenský rejstřík",
  "Ministerstvo spravedlnosti",
  "zapsáno v obchodním rejstříku",
  "jednatel společnosti",
  "prokura",
];

const MIXED_PATTERNS = [
  ...LITERAL_PATTERNS,
  ...LEGAL_PATTERNS,
];

// ─── Corpus generators ─────────────────────────────

/** Paragraph with lots of PII / legal identifiers. */
const RICH_PARAGRAPH =
  "Objednatel: společnost s ručením omezeným " +
  "Novák & Partneři, s.r.o., IČO: 12345678, " +
  "DIČ: CZ12345678, se sídlem Praha 1, " +
  "Vodičkova 30, PSČ 110 00, " +
  "zapsáno v obchodním rejstříku vedeném " +
  "Městský soud v Praze, oddíl C, vložka 12345. " +
  "Zastoupen: Ing. Jan Novák, jednatel společnosti, " +
  "rodné číslo: 850101/1234, " +
  "datum narození: 1. 1. 1985, " +
  "kontakt: jan.novak@example.com, " +
  "+420 123 456 789. " +
  "Krajský soud v Brně eviduje akciová společnost " +
  "pod sp. zn.: 42 C 100/2025, č. j.: AK-2025/001. " +
  "Ministerstvo spravedlnosti, živnostenský rejstřík. " +
  "JUDr. Marie Svobodová, MUDr. Pavel Dvořák, " +
  "Mgr. Karel Horák, prokura.\n\n";

/** Filler paragraph: legal text with no PII. */
const FILLER_PARAGRAPHS = [
  "Smluvní strany se dohodly na následujících " +
    "podmínkách spolupráce v souladu s platnými " +
    "právními předpisy České republiky. Tato smlouva " +
    "je uzavřena podle ustanovení občanského zákoníku " +
    "a je závazná pro obě smluvní strany.\n\n",
  "Předmětem smlouvy je poskytování konzultačních " +
    "služeb v oblasti finančního poradenství. " +
    "Poskytovatel se zavazuje provádět analýzy " +
    "a připravovat zprávy v dohodnutém rozsahu " +
    "a kvalitě.\n\n",
  "Odměna za poskytované služby bude hrazena " +
    "na základě měsíční fakturace se splatností " +
    "třicet kalendářních dnů od doručení faktury. " +
    "Smluvní strany se mohou dohodnout na jiném " +
    "způsobu úhrady.\n\n",
  "V případě porušení smluvních povinností má " +
    "poškozená strana nárok na smluvní pokutu ve " +
    "výši stanovené touto smlouvou. Nárok na náhradu " +
    "škody tím není dotčen.\n\n",
  "Tato smlouva se uzavírá na dobu neurčitou " +
    "s výpovědní dobou tři kalendářní měsíce. " +
    "Výpověď musí být doručena druhé smluvní straně " +
    "v písemné formě.\n\n",
  "Smlouva nabývá platnosti a účinnosti dnem jejího " +
    "podpisu oběma smluvními stranami. Je vyhotovena " +
    "ve dvou stejnopisech, z nichž každá strana " +
    "obdrží jeden.\n\n",
  "Práva a povinnosti neupravené touto smlouvou se " +
    "řídí příslušnými ustanoveními občanského " +
    "zákoníku a dalších právních předpisů České " +
    "republiky.\n\n",
  "Smluvní strany prohlašují, že si smlouvu přečetly, " +
    "jejímu obsahu rozumějí a na důkaz své svobodné " +
    "a vážné vůle připojují své podpisy.\n\n",
  "Veškeré změny a doplňky této smlouvy musí být " +
    "provedeny formou písemných číslovaných dodatků " +
    "podepsaných oběma smluvními stranami.\n\n",
  "Nedílnou součástí této smlouvy jsou přílohy " +
    "uvedené v závěrečném ustanovení. Přílohy mají " +
    "stejnou právní váhu jako samotný text smlouvy.\n\n",
];

/**
 * Generate corpus with configurable match density.
 * @param sizeKB Target size in KB
 * @param density Fraction of text that contains matches (0-1)
 */
function generateCorpus(
  sizeKB: number,
  density: number,
): string {
  const targetBytes = sizeKB * 1024;
  let result = "";
  let fillerIdx = 0;

  while (result.length < targetBytes) {
    // Decide: rich paragraph or filler?
    if (Math.random() < density) {
      result += RICH_PARAGRAPH;
    } else {
      result +=
        FILLER_PARAGRAPHS[
          fillerIdx % FILLER_PARAGRAPHS.length
        ];
      fillerIdx++;
    }
  }

  return result.slice(0, targetBytes);
}

// ─── Benchmark helpers ─────────────────────────────

type BenchResult = {
  name: string;
  avgMs: number;
  matchCount: number;
};

function bench(
  name: string,
  fn: () => number,
  iterations = 200,
  warmup = 20,
): BenchResult {
  let matchCount = 0;
  for (let i = 0; i < warmup; i++) {
    matchCount = fn();
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const elapsed = performance.now() - start;

  return {
    name,
    avgMs: elapsed / iterations,
    matchCount,
  };
}

function printResults(results: BenchResult[]): void {
  const fastest = Math.min(
    ...results.map((r) => r.avgMs),
  );

  for (const r of results) {
    const ratio = r.avgMs / fastest;
    const bar = "█".repeat(
      Math.min(
        30,
        Math.round(30 * (fastest / r.avgMs)),
      ),
    );
    console.log(
      `  ${r.name.padEnd(30)} ` +
        `${r.avgMs.toFixed(3).padStart(8)} ms  ` +
        `${String(r.matchCount).padStart(5)} hits  ` +
        `${ratio.toFixed(1).padStart(5)}x  ${bar}`,
    );
  }
}

// ─── Main ──────────────────────────────────────────

function runBenchmarks(): void {
  // Seed random for reproducibility
  const densities = [
    { label: "Dense (100%)", density: 1.0 },
    { label: "Medium (20%)", density: 0.2 },
    { label: "Sparse (5%)", density: 0.05 },
    { label: "Very sparse (1%)", density: 0.01 },
  ];

  const sizes = [50, 200, 500];

  console.log("═══════════════════════════════════════");
  console.log("  @stll/text-search Pre-filter Bench");
  console.log("═══════════════════════════════════════");
  console.log();

  for (const { label, density } of densities) {
    console.log(`━━━ ${label} ━━━`);
    console.log();

    for (const sizeKB of sizes) {
      const corpus = generateCorpus(sizeKB, density);
      console.log(
        `  ── ${sizeKB}KB ` +
          `(${corpus.length.toLocaleString()} chars) ──`,
      );

      // Build engines once per corpus size
      const regexOnly = new RegexSet(LEGAL_PATTERNS);
      const currentTs = new TextSearch(MIXED_PATTERNS);
      const acOnly = new AhoCorasick(LITERAL_PATTERNS);

      const prefiltered = new PrefilteredEngine(
        LEGAL_PATTERNS.map((p, i) => ({
          pattern: p,
          originalIndex: i,
        })),
        {
          unicodeBoundaries: true,
          wholeWords: false,
          caseInsensitive: false,
        },
      );

      // Also test with smaller margin
      const prefilteredSmall = new PrefilteredEngine(
        LEGAL_PATTERNS.map((p, i) => ({
          pattern: p,
          originalIndex: i,
        })),
        {
          unicodeBoundaries: true,
          wholeWords: false,
          caseInsensitive: false,
          margin: 48,
        },
      );

      const results = [
        bench(
          "AC-only (upper bound)",
          () => acOnly.findIter(corpus).length,
        ),
        bench(
          "RegexSet full scan",
          () => regexOnly.findIter(corpus).length,
        ),
        bench(
          "Current TextSearch",
          () => currentTs.findIter(corpus).length,
        ),
        bench(
          "Prefiltered (margin=128)",
          () => {
            const ac = acOnly.findIter(corpus).length;
            const pf =
              prefiltered.findIter(corpus).length;
            return ac + pf;
          },
        ),
        bench(
          "Prefiltered (margin=48)",
          () => {
            const ac = acOnly.findIter(corpus).length;
            const pf =
              prefilteredSmall.findIter(corpus).length;
            return ac + pf;
          },
        ),
      ];

      printResults(results);

      // Key comparison
      const rsMs =
        results.find(
          (r) => r.name === "RegexSet full scan",
        )?.avgMs ?? 0;
      const pfMs =
        results.find((r) =>
          r.name.startsWith("Prefiltered (margin=48)"),
        )?.avgMs ?? 0;
      const tsMs =
        results.find(
          (r) => r.name === "Current TextSearch",
        )?.avgMs ?? 0;

      if (pfMs > 0 && rsMs > 0) {
        console.log(
          `  → Prefilter vs RegexSet: ` +
            `${(rsMs / pfMs).toFixed(2)}x`,
        );
      }
      if (pfMs > 0 && tsMs > 0) {
        console.log(
          `  → Prefilter vs Current: ` +
            `${(tsMs / pfMs).toFixed(2)}x`,
        );
      }
      console.log();
    }
  }

  // ─── Correctness ─────────────────────────────
  console.log("── Correctness Check ──");
  const testCorpus = generateCorpus(10, 0.5);

  const regexBaseline = new RegexSet(LEGAL_PATTERNS);
  const baselineMatches =
    regexBaseline.findIter(testCorpus);

  const pfEngine = new PrefilteredEngine(
    LEGAL_PATTERNS.map((p, i) => ({
      pattern: p,
      originalIndex: i,
    })),
    {
      unicodeBoundaries: true,
      wholeWords: false,
      caseInsensitive: false,
    },
  );
  const pfMatches = pfEngine.findIter(testCorpus);

  console.log(
    `  RegexSet baseline: ${baselineMatches.length}`,
  );
  console.log(
    `  Prefiltered:       ${pfMatches.length}`,
  );

  const baseSet = new Set(
    baselineMatches.map(
      (m) => `${m.start}:${m.end}`,
    ),
  );
  const pfSet = new Set(
    pfMatches.map((m) => `${m.start}:${m.end}`),
  );

  let missing = 0;
  let extra = 0;
  for (const k of baseSet) {
    if (!pfSet.has(k)) {
      missing++;
      const m = baselineMatches.find(
        (x) => `${x.start}:${x.end}` === k,
      );
      console.log(`  MISSING: ${k} "${m?.text}"`);
    }
  }
  for (const k of pfSet) {
    if (!baseSet.has(k)) {
      extra++;
      const m = pfMatches.find(
        (x) => `${x.start}:${x.end}` === k,
      );
      console.log(`  EXTRA: ${k} "${m?.text}"`);
    }
  }

  if (missing === 0 && extra === 0) {
    console.log(
      "  ✓ Prefiltered matches baseline exactly",
    );
  } else {
    console.log(
      `  ✗ ${missing} missing, ${extra} extra`,
    );
  }
}

runBenchmarks();
