import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { TextSearch } from "../src/index.ts";

const DEFAULT_MAX_FIND_MS = 15_000;
const DEFAULT_MAX_BUILD_MS = 15_000;

const fixtureNames = [
  ["edgar employment agreement", "en/pra-group-employment-agreement.txt"],
  ["czech nakit legal services framework", "cs/nakit-legal-services-framework.txt"],
];

const candidatePackageDirs = [
  process.env.ANONYMIZE_PACKAGE_DIR,
  resolve(process.cwd(), ".perf/anonymize/packages/anonymize"),
  resolve(process.cwd(), "../anonymize/packages/anonymize"),
  resolve(process.cwd(), "../anonymize-ts/packages/anonymize"),
].filter((value) => value !== undefined);

const packageDir = candidatePackageDirs.find((candidate) =>
  existsSync(join(candidate, "src/detectors/regex.ts")),
);

if (!packageDir) {
  throw new Error("Set ANONYMIZE_PACKAGE_DIR to an anonymize packages/anonymize checkout");
}

const importFromAnonymize = (relativePath) =>
  import(pathToFileURL(join(packageDir, relativePath)).href);

const { DEFAULT_ENTITY_LABELS } = await importFromAnonymize("src/constants.ts");
const {
  REGEX_PATTERNS,
  REGEX_META,
  CURRENCY_PATTERN_META,
  DATE_PATTERN_META,
  SIGNING_CLAUSE_META,
  getCurrencyPatternEntries,
  getCurrencyPatterns,
  getDatePatterns,
  getSigningClausePatterns,
} = await importFromAnonymize("src/detectors/regex.ts");
const { buildTriggerPatterns } = await importFromAnonymize("src/detectors/triggers.ts");
const { buildDenyList } = await importFromAnonymize("src/detectors/deny-list.ts");
const { buildStreetTypePatterns } = await importFromAnonymize("src/detectors/address-seeds.ts");
const { buildCountryPatterns } = await importFromAnonymize("src/detectors/countries.ts");
const { createPipelineContext } = await importFromAnonymize("src/context.ts");
const { loadTestDictionaries } = await importFromAnonymize("src/__test__/load-dictionaries.ts");
const { normalizeForSearch } = await importFromAnonymize("src/util/normalize.ts");

const maxBuildMs = Number(process.env.TEXT_SEARCH_CONTRACT_MAX_BUILD_MS ?? DEFAULT_MAX_BUILD_MS);
const maxFindMs = Number(process.env.TEXT_SEARCH_CONTRACT_MAX_FIND_MS ?? DEFAULT_MAX_FIND_MS);
const maxRegexEngines = Number(process.env.TEXT_SEARCH_CONTRACT_MAX_REGEX_ENGINES ?? 128);
const includeFullLiterals = process.env.TEXT_SEARCH_CONTRACT_INCLUDE_FULL_LITERALS === "1";
const verboseEngines = process.env.TEXT_SEARCH_CONTRACT_VERBOSE === "1";
const regexChunkSize =
  process.env.TEXT_SEARCH_CONTRACT_REGEX_CHUNK_SIZE === undefined
    ? undefined
    : Number(process.env.TEXT_SEARCH_CONTRACT_REGEX_CHUNK_SIZE);

const allowedLabels = new Set(DEFAULT_ENTITY_LABELS);
const config = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableLegalForms: true,
  enableNameCorpus: true,
  enableDenyList: true,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: true,
  enableCoreference: true,
  enableHotwordRules: true,
  enableZoneClassification: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "contract-fixture-perf",
  dictionaries: includeFullLiterals ? await loadTestDictionaries() : undefined,
};
const regexPatterns = [];
const regexMeta = [];

for (const [index, pattern] of REGEX_PATTERNS.entries()) {
  const meta = REGEX_META[index];
  if (!meta || !allowedLabels.has(meta.label)) continue;
  regexPatterns.push(pattern);
  regexMeta.push(meta);
}

const currencyPatterns =
  typeof getCurrencyPatternEntries === "function"
    ? await getCurrencyPatternEntries()
    : await getCurrencyPatterns();

for (const pattern of currencyPatterns) {
  regexPatterns.push(pattern);
  regexMeta.push(CURRENCY_PATTERN_META);
}
for (const pattern of await getDatePatterns()) {
  regexPatterns.push(pattern);
  regexMeta.push(DATE_PATTERN_META);
}
for (const pattern of await getSigningClausePatterns()) {
  regexPatterns.push(pattern);
  regexMeta.push(SIGNING_CLAUSE_META);
}

const triggers = await buildTriggerPatterns();
const triggerEntries = triggers.patterns.map((pattern) => ({
  pattern,
  literal: true,
  caseInsensitive: true,
}));

const buildStart = Bun.nanoseconds();
const regexOptions = regexChunkSize === undefined ? {} : { regexChunkSize };
const regexSearch = new TextSearch([...regexPatterns, ...triggerEntries], regexOptions);
let literalSearch = null;
let literalPatterns = [];
if (includeFullLiterals) {
  const denyListData = await buildDenyList(config, createPipelineContext());
  const streetTypes = await buildStreetTypePatterns();
  const countryPatterns = buildCountryPatterns().patterns;
  const alnumRe = /[\p{L}\p{N}]/u;
  const customDenyListNeedsWholeWords = (pattern) => {
    const first = pattern.at(0) ?? "";
    const last = pattern.at(-1) ?? "";
    return alnumRe.test(first) && alnumRe.test(last);
  };
  const wrapWholeWord = (pattern, wholeWords) => ({
    pattern,
    literal: true,
    wholeWords,
  });
  const hasCustomDenyListPatterns = denyListData.sources.some((sources) =>
    sources.includes("custom-deny-list"),
  );
  literalPatterns = hasCustomDenyListPatterns
    ? [
        ...denyListData.originals.map((pattern, index) =>
          wrapWholeWord(
            pattern,
            (denyListData.sources[index] ?? []).includes("custom-deny-list")
              ? customDenyListNeedsWholeWords(pattern)
              : true,
          ),
        ),
        ...streetTypes.map((pattern) => wrapWholeWord(pattern, true)),
        ...countryPatterns,
      ]
    : [...denyListData.originals, ...streetTypes, ...countryPatterns.map((entry) => entry.pattern)];
  literalSearch = new TextSearch(literalPatterns, {
    ...(hasCustomDenyListPatterns ? {} : { allLiteral: true, wholeWords: true }),
    caseInsensitive: true,
    overlapStrategy: "all",
  });
}
const buildMs = (Bun.nanoseconds() - buildStart) / 1_000_000;
const regexEngines = Reflect.get(regexSearch, "engines");
const literalEngines = literalSearch ? Reflect.get(literalSearch, "engines") : [];
const regexEngineCount = regexEngines.filter((engine) => engine.type === "regex").length;
const summarizeEngines = (engines) => {
  const summary = new Map();
  for (const engine of engines) {
    const patterns = engine.patternCount ?? engine.indexMap.length;
    const current = summary.get(engine.type) ?? {
      type: engine.type,
      slots: 0,
      patterns: 0,
      minPatterns: Number.POSITIVE_INFINITY,
      maxPatterns: 0,
    };
    current.slots++;
    current.patterns += patterns;
    current.minPatterns = Math.min(current.minPatterns, patterns);
    current.maxPatterns = Math.max(current.maxPatterns, patterns);
    summary.set(engine.type, current);
  }
  const entries = [];
  for (const entry of summary.values()) {
    entries.push({
      type: entry.type,
      slots: entry.slots,
      patterns: entry.patterns,
      minPatterns: entry.minPatterns === Number.POSITIVE_INFINITY ? 0 : entry.minPatterns,
      maxPatterns: entry.maxPatterns,
    });
  }
  return entries;
};
const engineDetails = (engines) =>
  engines.map((engine) => ({
    type: engine.type,
    patterns: engine.patternCount ?? engine.indexMap.length,
  }));

console.log(
  JSON.stringify({
    event: "build",
    buildMs,
    regexPatterns: regexPatterns.length,
    triggerPatterns: triggerEntries.length,
    literalPatterns: literalPatterns.length,
    regexChunkSize: regexChunkSize ?? "auto",
    regexEngineCount,
    regexEngines: verboseEngines ? engineDetails(regexEngines) : summarizeEngines(regexEngines),
    literalEngines: verboseEngines
      ? engineDetails(literalEngines)
      : summarizeEngines(literalEngines),
  }),
);

if (buildMs > maxBuildMs) {
  throw new Error(`build exceeded ${maxBuildMs}ms: ${buildMs.toFixed(2)}ms`);
}

if (regexEngineCount > maxRegexEngines) {
  throw new Error(`too many regex engines: ${regexEngineCount}`);
}

for (const [fixtureName, relativePath] of fixtureNames) {
  const text = readFileSync(
    join(packageDir, "src/__test__/fixtures/contracts", relativePath),
    "utf8",
  );
  const start = Bun.nanoseconds();
  const regexMatches = regexSearch.findIter(text);
  const regexMs = (Bun.nanoseconds() - start) / 1_000_000;
  const literalStart = Bun.nanoseconds();
  const literalMatches = literalSearch ? literalSearch.findIter(normalizeForSearch(text)) : [];
  const literalMs = literalSearch ? (Bun.nanoseconds() - literalStart) / 1_000_000 : 0;
  const findMs = (Bun.nanoseconds() - start) / 1_000_000;

  console.log(
    JSON.stringify({
      event: "fixture",
      fixture: fixtureName,
      textLength: text.length,
      findMs,
      regexMs,
      regexMatches: regexMatches.length,
      literalMs,
      literalMatches: literalMatches.length,
    }),
  );

  if (findMs > maxFindMs) {
    throw new Error(`${fixtureName} exceeded ${maxFindMs}ms: ${findMs.toFixed(2)}ms`);
  }
}
