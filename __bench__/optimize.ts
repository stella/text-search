/**
 * Benchmark: finding the actual optimization.
 *
 * Key insight: regex-automata already has internal
 * literal pre-filtering. Adding an AC pre-pass is
 * redundant. The real bottleneck is running TWO
 * separate engines (AC + RegexSet) when ONE would do.
 *
 * Approaches:
 * 1. Current: AC for literals + RegexSet for regex
 *    (two full-text scans + merge)
 * 2. Unified RegexSet: all patterns (including
 *    literals escaped as regex) in one RegexSet
 *    (one scan, no merge)
 * 3. AC-only: literals-only baseline (upper bound)
 * 4. RegexSet-only: regex patterns only
 * 5. Prefiltered: AC pre-pass + RegexSet on regions
 */

import { AhoCorasick } from "@stll/aho-corasick";
import { RegexSet } from "@stll/regex-set";

import { TextSearch } from "../src/text-search";

// ─── Patterns ──────────────────────────────────────

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

const REGEX_PATTERNS = [
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

const ALL_PATTERNS = [
  ...LITERAL_PATTERNS,
  ...REGEX_PATTERNS,
];

// Escape literal patterns for regex
function escapeRegex(s: string): string {
  return s.replaceAll(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
}

const ALL_AS_REGEX = [
  ...LITERAL_PATTERNS.map(escapeRegex),
  ...REGEX_PATTERNS,
];

// ─── Corpus ────────────────────────────────────────

const RICH =
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

const FILLER = [
  "Smluvní strany se dohodly na následujících " +
    "podmínkách spolupráce v souladu s platnými " +
    "právními předpisy České republiky.\n\n",
  "Předmětem smlouvy je poskytování konzultačních " +
    "služeb v oblasti finančního poradenství.\n\n",
  "Odměna za poskytované služby bude hrazena " +
    "na základě měsíční fakturace se splatností " +
    "třicet kalendářních dnů.\n\n",
  "V případě porušení smluvních povinností má " +
    "poškozená strana nárok na smluvní pokutu.\n\n",
  "Tato smlouva se uzavírá na dobu neurčitou " +
    "s výpovědní dobou tři kalendářní měsíce.\n\n",
  "Smlouva nabývá platnosti a účinnosti dnem jejího " +
    "podpisu oběma smluvními stranami.\n\n",
  "Práva a povinnosti neupravené touto smlouvou se " +
    "řídí příslušnými ustanoveními občanského " +
    "zákoníku.\n\n",
  "Smluvní strany prohlašují, že si smlouvu přečetly, " +
    "jejímu obsahu rozumějí.\n\n",
  "Veškeré změny a doplňky této smlouvy musí být " +
    "provedeny formou písemných číslovaných dodatků.\n\n",
  "Nedílnou součástí této smlouvy jsou přílohy " +
    "uvedené v závěrečném ustanovení.\n\n",
];

function generateCorpus(
  sizeKB: number,
  density: number,
): string {
  const target = sizeKB * 1024;
  let result = "";
  let fi = 0;

  while (result.length < target) {
    if (Math.random() < density) {
      result += RICH;
    } else {
      result += FILLER[fi % FILLER.length];
      fi++;
    }
  }

  return result.slice(0, target);
}

// ─── Bench helpers ─────────────────────────────────

type R = {
  name: string;
  avgMs: number;
  matchCount: number;
};

function bench(
  name: string,
  fn: () => number,
  iterations = 200,
  warmup = 20,
): R {
  let mc = 0;
  for (let i = 0; i < warmup; i++) mc = fn();

  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - t0;

  return {
    name,
    avgMs: elapsed / iterations,
    matchCount: mc,
  };
}

function print(results: R[]): void {
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
      `  ${r.name.padEnd(35)} ` +
        `${r.avgMs.toFixed(3).padStart(8)} ms  ` +
        `${String(r.matchCount).padStart(5)} hits  ` +
        `${ratio.toFixed(1).padStart(5)}x  ${bar}`,
    );
  }
}

// ─── Main ──────────────────────────────────────────

function run(): void {
  console.log("═══════════════════════════════════════");
  console.log("  Engine Count Optimization Bench");
  console.log("═══════════════════════════════════════");
  console.log();

  const configs = [
    { label: "Dense (100%)", density: 1.0 },
    { label: "Sparse (5%)", density: 0.05 },
    { label: "Very sparse (1%)", density: 0.01 },
  ];

  const sizes = [50, 200, 500, 1000];

  for (const { label, density } of configs) {
    console.log(`━━━ ${label} ━━━`);
    console.log();

    for (const sizeKB of sizes) {
      const corpus = generateCorpus(sizeKB, density);
      console.log(
        `  ── ${sizeKB}KB ──`,
      );

      // 1. Current TextSearch (AC + RegexSet separate)
      const currentTs = new TextSearch(ALL_PATTERNS);

      // 2. Unified: everything in one RegexSet
      const unifiedRs = new RegexSet(ALL_AS_REGEX);

      // 3. AC-only (upper bound for literals)
      const acOnly = new AhoCorasick(LITERAL_PATTERNS);

      // 4. RegexSet-only (regex patterns)
      const rsOnly = new RegexSet(REGEX_PATTERNS);

      // 5. Two separate engines, no merge overhead
      // (measures pure scanning cost)

      // 6. Unified TextSearch (allLiteral=false,
      //    routes literals to regex too)
      const unifiedTs = new TextSearch(
        ALL_AS_REGEX,
      );

      const results = [
        bench(
          "AC-only (literals)",
          () => acOnly.findIter(corpus).length,
        ),
        bench(
          "RegexSet-only (regex)",
          () => rsOnly.findIter(corpus).length,
        ),
        bench(
          "AC + RegexSet (raw, no merge)",
          () => {
            const a = acOnly.findIter(corpus).length;
            const r = rsOnly.findIter(corpus).length;
            return a + r;
          },
        ),
        bench(
          "Current TextSearch (AC+RS+merge)",
          () => currentTs.findIter(corpus).length,
        ),
        bench(
          "Unified RegexSet (one engine)",
          () => unifiedRs.findIter(corpus).length,
        ),
        bench(
          "Unified via TextSearch",
          () => unifiedTs.findIter(corpus).length,
        ),
      ];

      print(results);

      // Key comparisons
      const currentMs =
        results.find((r) =>
          r.name.includes("Current"),
        )?.avgMs ?? 0;
      const unifiedMs =
        results.find((r) =>
          r.name.includes("Unified RegexSet"),
        )?.avgMs ?? 0;
      const rawDualMs =
        results.find((r) =>
          r.name.includes("raw, no merge"),
        )?.avgMs ?? 0;

      if (unifiedMs > 0 && currentMs > 0) {
        console.log(
          `  → Unified vs Current: ` +
            `${(currentMs / unifiedMs).toFixed(2)}x speedup`,
        );
      }
      if (rawDualMs > 0 && unifiedMs > 0) {
        console.log(
          `  → Unified vs raw dual: ` +
            `${(rawDualMs / unifiedMs).toFixed(2)}x`,
        );
      }
      console.log();
    }
  }

  // ─── Correctness ─────────────────────────────
  console.log("── Correctness Check ──");
  const tc = generateCorpus(10, 0.5);

  const currentMatches = new TextSearch(
    ALL_PATTERNS,
  ).findIter(tc);
  const unifiedMatches = new RegexSet(
    ALL_AS_REGEX,
  ).findIter(tc);

  console.log(
    `  Current TextSearch: ${currentMatches.length}`,
  );
  console.log(
    `  Unified RegexSet:   ${unifiedMatches.length}`,
  );

  // Compare by position (pattern indices differ)
  const currentPositions = new Set(
    currentMatches.map(
      (m) => `${m.start}:${m.end}:${m.text}`,
    ),
  );
  const unifiedPositions = new Set(
    unifiedMatches.map(
      (m) => `${m.start}:${m.end}:${m.text}`,
    ),
  );

  let missing = 0;
  let extra = 0;
  for (const k of currentPositions) {
    if (!unifiedPositions.has(k)) {
      missing++;
      if (missing <= 5) {
        console.log(`  In current, not unified: ${k}`);
      }
    }
  }
  for (const k of unifiedPositions) {
    if (!currentPositions.has(k)) {
      extra++;
      if (extra <= 5) {
        console.log(`  In unified, not current: ${k}`);
      }
    }
  }

  if (missing === 0 && extra === 0) {
    console.log("  ✓ Results match exactly");
  } else {
    console.log(
      `  Δ ${missing} only-in-current, ` +
        `${extra} only-in-unified ` +
        `(expected: AC wholeWords/overlap diffs)`,
    );
  }
}

run();
