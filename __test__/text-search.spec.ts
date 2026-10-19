import { afterEach, describe, expect, test } from "bun:test";

import { EmptyPatternError, TextSearch } from "../src";
import { getEngines, initEngines } from "../src/engines";
import { textSearchTestHooks } from "../src/text-search";
import type { Match } from "../src/types";

const registeredEngines = getEngines();
afterEach(() => {
  initEngines(registeredEngines);
  textSearchTestHooks.reset();
});

describe("TextSearch", () => {
  test("basic matching", () => {
    const ts = new TextSearch(["foo", "bar"]);
    expect(ts.length).toBe(2);
    expect(ts.isMatch("hello foo")).toBe(true);
    expect(ts.isMatch("xyz")).toBe(false);
  });

  test("findIter returns matches", () => {
    const ts = new TextSearch(["foo", "bar"]);
    const matches = ts.findIter("foo bar foo");
    expect(matches.length).toBeGreaterThan(0);
    const texts = matches.map((m) => m.text);
    expect(texts).toContain("foo");
    expect(texts).toContain("bar");
  });

  test("literal longest selection matches the core regardless of insertion order", () => {
    for (const patterns of [
      ["a", "aa", "aaa"],
      ["aaa", "aa", "a"],
      ["aa", "a", "aaa"],
    ]) {
      const search = new TextSearch(patterns, { allLiteral: true });
      expect(search.findIter("aaaa").map(({ text }) => text)).toEqual(["aaa", "a"]);
      expect(
        search.replaceAll(
          "aaaa",
          patterns.map((pattern) => `[${pattern}]`),
        ),
      ).toBe("[aaa][a]");
    }
  });

  test("single literal engine matches global selection on a generated corpus", () => {
    const patterns = Array.from({ length: 24 }, (_, index) => "a".repeat(index + 1));
    const haystack = Array.from(
      { length: 40 },
      (_, index) => `${"a".repeat((index * 7) % 31)}b`,
    ).join("");
    const direct = new TextSearch(patterns, { allLiteral: true });
    const globallySelected = new TextSearch([...patterns, /z+/], { allLiteral: false });

    expect(globallySelected.findIter(haystack)).toEqual(direct.findIter(haystack));
  });

  test("single literal engine uses its native iterator", () => {
    const search = new TextSearch([{ pattern: "a", literal: true, name: "letter" }]);
    const engine = Reflect.get(search, "engines")[0];
    const ac = engine.ac;
    let nativeCalls = 0;
    const nativeFindIter = ac.findIter.bind(ac);
    ac.findIter = (haystack: string) => {
      nativeCalls += 1;
      return nativeFindIter(haystack);
    };
    ac.findOverlappingIter = () => {
      throw new Error("overlapping iterator should not run");
    };

    expect(search.findIter("aaa").map(({ name }) => name)).toEqual(["letter", "letter", "letter"]);
    expect(nativeCalls).toBe(1);
  });

  test("single regex and fuzzy engines return their native result arrays", () => {
    for (const search of [
      new TextSearch([/a+/]),
      new TextSearch([{ pattern: "alpha", distance: 1 }]),
    ]) {
      const slot = Reflect.get(search, "engines")[0];
      const engine = slot.type === "regex" ? slot.rs : slot.fs;
      const expected = engine.findIter("alpha");
      let calls = 0;
      engine.findIter = () => {
        calls += 1;
        return expected;
      };

      expect(search.findIter("alpha")).toBe(expected);
      expect(calls).toBe(1);
    }
  });

  test("single non-literal routes match global routing on a generated corpus", () => {
    let state = 0x169;
    const random = () => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state;
    };
    for (let iteration = 0; iteration < 64; iteration += 1) {
      const haystack = Array.from({ length: random() % 40 }, () =>
        random() % 3 === 0 ? "b" : "a",
      ).join("");
      for (const pattern of [/a+/, { pattern: "aaa", distance: 1 }]) {
        const direct = new TextSearch([pattern]);
        const routed = new TextSearch([pattern, { pattern: "never", literal: true }]);
        const publicFields = ({ pattern: patternIndex, start, end, text, name, distance }: Match) => ({
          pattern: patternIndex,
          start,
          end,
          text,
          name,
          distance,
        });
        expect(direct.findIter(haystack).map(publicFields)).toEqual(
          routed.findIter(haystack).map(publicFields),
        );
      }
    }
  });

  test("eligible replaceAll uses the native literal iterator for every overlap strategy", () => {
    for (const overlapStrategy of ["longest", "all"] as const) {
      const search = new TextSearch(["a", "aa"], { allLiteral: true, overlapStrategy });
      const engine = Reflect.get(search, "engines")[0];
      const ac = engine.ac;
      let nativeCalls = 0;
      const nativeFindIter = ac.findIter.bind(ac);
      ac.findIter = (haystack: string) => {
        nativeCalls += 1;
        return nativeFindIter(haystack);
      };
      ac.findOverlappingIter = () => {
        throw new Error("overlapping iterator should not run");
      };

      expect(search.replaceAll("aaa", ["A", "AA"])).toBe("AAA");
      expect(nativeCalls).toBe(1);
    }
  });

  test("literal groups without empty patterns build one automaton", () => {
    let constructions = 0;
    const NativeAhoCorasick = registeredEngines.AhoCorasick;
    class CountingAhoCorasick extends NativeAhoCorasick {
      constructor(...args: ConstructorParameters<typeof NativeAhoCorasick>) {
        super(...args);
        constructions += 1;
      }
    }
    initEngines({ ...registeredEngines, AhoCorasick: CountingAhoCorasick });

    new TextSearch([{ pattern: "alpha", literal: true }]);
    expect(constructions).toBe(1);
  });

  test("eligible replaceAll matches global selection on a generated corpus", () => {
    const patterns = Array.from({ length: 24 }, (_, index) => "a".repeat(index + 1));
    const replacements = patterns.map((_, index) => `[${index}]`);
    const haystack = Array.from(
      { length: 40 },
      (_, index) => `${"a".repeat((index * 7) % 31)}b`,
    ).join("");
    const direct = new TextSearch(patterns, { allLiteral: true });
    const globallySelected = new TextSearch([...patterns, /z+/]);

    expect(direct.replaceAll(haystack, replacements)).toBe(
      globallySelected.replaceAll(haystack, [...replacements, "unused"]),
    );
  });

  test("duplicate empty literals are rejected with their index and name", () => {
    expect(() => new TextSearch(["", ""], { allLiteral: true })).toThrow(
      new EmptyPatternError(0),
    );
    expect(
      () =>
        new TextSearch([
          { pattern: "", literal: true, name: "first" },
          { pattern: "", literal: true, name: "second" },
        ]),
    ).toThrow(new EmptyPatternError(0, "first"));
  });

  test('overlap "all" rejects duplicate empty literals', () => {
    expect(
      () => new TextSearch(["", ""], { allLiteral: true, overlapStrategy: "all" }),
    ).toThrow(EmptyPatternError);
  });

  test("split literal route rejects duplicate empty literals", () => {
    const patterns = ["", "", ...Array.from({ length: 19_998 }, (_, index) => `missing-${index}`)];
    expect(
      () =>
        new TextSearch(patterns, {
          allLiteral: true,
          wholeWords: true,
          unicodeBoundaries: true,
          overlapStrategy: "all",
        }),
    ).toThrow(new EmptyPatternError(0));
  });

  test("forced literal routes have identical randomized results", () => {
    let state = 0x169;
    const randomInt = (upperBound: number) => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return (state >>> 8) % upperBound;
    };
    const atoms = ["a", "ab", "é", "𐐀", "_", " "];
    const haystackAtoms = ["a", "b", "é", "𐐀", " ", "_", "\uD800", "\uDC00"];
    const optionCombinations = [
      { allLiteral: true, overlapStrategy: "longest", wholeWords: false, unicodeBoundaries: false },
      { allLiteral: true, overlapStrategy: "longest", wholeWords: false, unicodeBoundaries: true },
      { allLiteral: true, overlapStrategy: "longest", wholeWords: true, unicodeBoundaries: false },
      { allLiteral: true, overlapStrategy: "longest", wholeWords: true, unicodeBoundaries: true },
      { allLiteral: true, overlapStrategy: "all", wholeWords: false, unicodeBoundaries: false },
      { allLiteral: true, overlapStrategy: "all", wholeWords: false, unicodeBoundaries: true },
      { allLiteral: true, overlapStrategy: "all", wholeWords: true, unicodeBoundaries: false },
      { allLiteral: true, overlapStrategy: "all", wholeWords: true, unicodeBoundaries: true },
    ] as const;
    const expectedCombinationCount = 8;
    const casesPerCombination = 15;
    const exercisedCombinations = new Map<string, number>();

    for (const options of optionCombinations) {
      const combination = `${options.overlapStrategy}/${options.wholeWords}/${options.unicodeBoundaries}`;
      for (let iteration = 0; iteration < casesPerCombination; iteration += 1) {
        const patterns = Array.from(
          { length: 2 + randomInt(7) },
          () => atoms[randomInt(atoms.length)],
        );
        const haystack = Array.from(
          { length: randomInt(14) },
          () => haystackAtoms[randomInt(haystackAtoms.length)],
        ).join("");
        const replacements = patterns.map((_, index) => `<${index}>`);

        textSearchTestHooks.forceIdentityAcRoute("ordinary");
        const ordinary = new TextSearch(patterns, options);
        textSearchTestHooks.setIdentityAcChunkSize(2);
        textSearchTestHooks.forceIdentityAcRoute("split");
        const split = new TextSearch(patterns, options);

        expect(split.findIter(haystack)).toEqual(ordinary.findIter(haystack));
        expect(split.replaceAll(haystack, replacements)).toBe(
          ordinary.replaceAll(haystack, replacements),
        );
        exercisedCombinations.set(combination, (exercisedCombinations.get(combination) ?? 0) + 1);
      }
    }

    expect(exercisedCombinations.size).toBe(expectedCombinationCount);
    for (const count of exercisedCombinations.values()) {
      expect(count).toBeGreaterThanOrEqual(casesPerCombination);
    }
  });

  test("empty literals are rejected for Unicode whole-word inputs", () => {
    for (const haystack of ["𐐀a", "a\uDC00a", "a\uD800a"]) {
      expect(
        () =>
          new TextSearch([""], {
            allLiteral: true,
            wholeWords: true,
            unicodeBoundaries: true,
            overlapStrategy: "all",
          }),
      ).toThrow(new EmptyPatternError(0));
      expect(haystack.length).toBeGreaterThan(0);
    }
  });

  test("every literal entry form rejects an empty pattern", () => {
    const cases: Array<{ patterns: ConstructorParameters<typeof TextSearch>[0]; options?: ConstructorParameters<typeof TextSearch>[1]; name?: string }> = [
      { patterns: [""] },
      { patterns: [{ pattern: "", literal: true }] },
      { patterns: [{ pattern: "", literal: true, name: "named" }], name: "named" },
      { patterns: [""], options: { allLiteral: true } },
      { patterns: [{ pattern: "", name: "named" }], options: { allLiteral: true }, name: "named" },
    ];

    for (const { patterns, options, name } of cases) {
      try {
        new TextSearch(patterns, options);
        throw new Error("Expected empty literal construction to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(EmptyPatternError);
        expect(error).toMatchObject({ index: 0, ...(name === undefined ? {} : { patternName: name }) });
      }
    }
  });

  test("non-ASCII empty-literal regression throws without aborting its process", () => {
    const child = Bun.spawnSync([
      process.execPath,
      "-e",
      `import { EmptyPatternError, TextSearch } from "./src/index.ts";
       try {
         new TextSearch([{ pattern: "", literal: true }, /Z/], { wholeWords: true }).isMatch("éa");
         process.exit(2);
       } catch (error) {
         if (!(error instanceof EmptyPatternError)) process.exit(3);
       }`,
    ]);
    expect(child.exitCode).toBe(0);
  });

  test("ASCII whole-word filtering precedes longest selection", () => {
    const search = new TextSearch(["a", "a b"], {
      allLiteral: true,
      wholeWords: true,
      unicodeBoundaries: false,
    });
    expect(search.findIter("a bc").map(({ text }) => text)).toEqual(["a"]);
  });

  test("literal fast-path eligibility follows the shared option table", () => {
    const cases = [
      { options: { allLiteral: true }, eligible: true },
      { options: { allLiteral: true, wholeWords: true }, eligible: true },
      {
        options: { allLiteral: true, wholeWords: true, unicodeBoundaries: false },
        eligible: false,
      },
      {
        options: { allLiteral: true, overlapStrategy: "all" as const },
        eligible: false,
        replacementEligible: true,
      },
    ];

    for (const {
      options,
      eligible,
      replacementEligible = eligible,
      patterns = ["a", "a b"],
    } of cases) {
      const search = new TextSearch(patterns, options);
      const slot = Reflect.get(search, "engines")[0];
      const ac = slot.ac;
      let nativeCalls = 0;
      let overlappingCalls = 0;
      const nativeFindIter = ac.findIter.bind(ac);
      const overlappingFindIter = ac.findOverlappingIter.bind(ac);
      ac.findIter = (haystack: string) => {
        nativeCalls += 1;
        return nativeFindIter(haystack);
      };
      ac.findOverlappingIter = (haystack: string) => {
        overlappingCalls += 1;
        return overlappingFindIter(haystack);
      };

      search.findIter("a bc");
      expect(nativeCalls > 0).toBe(eligible);
      expect(overlappingCalls > 0).toBe(!eligible);

      nativeCalls = 0;
      overlappingCalls = 0;
      search.replaceAll(
        "a bc",
        patterns.map(() => "x"),
      );
      expect(nativeCalls > 0).toBe(replacementEligible);
      expect(overlappingCalls > 0).toBe(!replacementEligible);
    }
  });

  test("selects literal candidates globally across engine routes", () => {
    const first = new TextSearch([/ab/, "b", "bcdef", "fg"]);
    expect(
      first.findIter("abcdefg").map(({ pattern, start, end }) => ({ pattern, start, end })),
    ).toEqual([
      { pattern: 0, start: 0, end: 2 },
      { pattern: 3, start: 5, end: 7 },
    ]);
    expect(first.replaceAll("abcdefg", ["<AB>", "<B>", "<BCDEF>", "<FG>"])).toBe("<AB>cde<FG>");

    const second = new TextSearch(["a", "abcd", "dEF", /zab/]);
    expect(
      second.findIter("zabcdEF").map(({ pattern, start, end }) => ({ pattern, start, end })),
    ).toEqual([
      { pattern: 3, start: 0, end: 3 },
      { pattern: 2, start: 4, end: 7 },
    ]);
    expect(second.replaceAll("zabcdEF", ["<A>", "<ABCD>", "<DEF>", "<ZAB>"])).toBe("<ZAB>c<DEF>");
  });

  test("whichMatch reports overlapping literal patterns", () => {
    expect(new TextSearch(["a", "aa"], { allLiteral: true }).whichMatch("aa")).toEqual([0, 1]);
  });

  test("named patterns", () => {
    const ts = new TextSearch([
      { pattern: "\\d+", name: "number" },
      { pattern: "[a-z]+", name: "word" },
    ]);
    const matches = ts.findIter("abc 123");
    expect(matches.length).toBe(2);
    const named = matches.find((m) => m.name === "number");
    expect(named).toBeDefined();
    expect(named!.text).toBe("123");
  });

  test("whichMatch", () => {
    const ts = new TextSearch(["foo", "bar", "baz"]);
    const which = ts.whichMatch("foo and baz");
    expect(which).toContain(0);
    expect(which).toContain(2);
    expect(which).not.toContain(1);
  });

  test("replaceAll", () => {
    const ts = new TextSearch(["\\d{2}\\.\\d{2}\\.\\d{4}", "\\+?\\d{9,12}"]);
    const result = ts.replaceAll("Born 15.03.1990, phone +420123456789", ["[DATE]", "[PHONE]"]);
    expect(result).toBe("Born [DATE], phone [PHONE]");
  });

  test("replaceAll wrong count throws", () => {
    const ts = new TextSearch(["a", "b"]);
    expect(() => ts.replaceAll("ab", ["x"])).toThrow();
  });

  test("wide trailing lookahead preserves later legal-form matches", () => {
    const lower = "a-záčďéěíňóřšťúůýžäöüßàâæçèêëîïôùûÿñąćęłńśźż\\u0131";
    const upper = "A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽÄÖÜÀÂÆÇÈÊËÎÏÔÙÛŸÑĄĆĘŁŃŚŹŻ\\u0130";
    const hspace = "[^\\S\\n]";
    const simpleSep = `(?:${hspace}|[&,.-]){1,4}`;
    const capWord = `[${upper}][${lower}${upper}]*`;
    const capOrNum = `(?:${capWord}|[${upper}](?![${lower}${upper}])|\\d{1,4})`;
    const head = `(?:${capWord})(?:${simpleSep}(?:${capOrNum})){0,10}`;
    const suffixAlt = "LLC|Inc\\.|AG|SE|PA|AD";

    const wideBoundary = `${head}(?:${hspace}+|,${hspace}*)(?:${suffixAlt})(?![${lower}${upper}\\p{N}])`;
    const asciiBoundary = `${head}(?:${hspace}+|,${hspace}*)(?:${suffixAlt})(?![A-Za-z0-9])`;
    const text =
      "THIS AGREEMENT AND PLAN OF MERGER, dated as of April 25, 2022 " +
      '(this "Agreement"), is made by and among Twitter, Inc., ' +
      'a Delaware corporation (the "Company"), X Holdings I, Inc.';

    const wideMatches = new TextSearch([wideBoundary]).findIter(text).map((m) => m.text);
    const asciiMatches = new TextSearch([asciiBoundary]).findIter(text).map((m) => m.text);

    expect(wideMatches).toEqual(asciiMatches);
    expect(wideMatches).toEqual(["Twitter, Inc.", "X Holdings I, Inc."]);
  });
});

// ─── Auto-optimization ──────────────────────

describe("auto-optimization", () => {
  test("large alternation is isolated", () => {
    // 80-branch alternation + simple pattern
    const titles = Array.from({ length: 80 }, (_, i) => `title${i}`).join("|");
    const bigPattern = `(?:${titles})\\s+\\w+`;
    const smallPattern = "\\d+";

    // Should not throw or be slow
    const ts = new TextSearch([bigPattern, smallPattern], { maxAlternations: 50 });

    expect(ts.isMatch("title42 test")).toBe(true);
    expect(ts.isMatch("123")).toBe(true);
  });

  test("small alternation stays shared", () => {
    const ts = new TextSearch(["a|b|c", "d|e|f"], { maxAlternations: 50 });
    const matches = ts.findIter("a d");
    expect(matches).toHaveLength(2);
  });

  test("simple regex patterns auto-chunk", () => {
    const patterns = Array.from({ length: 100 }, (_, i) => `field${i}\\s*:\\s*\\d+`);

    const ts = new TextSearch(patterns, { maxAlternations: 50 });
    const engines = Reflect.get(ts, "engines");
    const regexEngines = engines.filter((engine: { type: string }) => engine.type === "regex");

    expect(regexEngines.length).toBeGreaterThan(1);
    expect(regexEngines.length).toBeLessThan(patterns.length);
    expect(regexEngines.flatMap((engine: { indexMap: number[] }) => engine.indexMap)).toHaveLength(
      patterns.length,
    );
  });

  test("complex regex patterns auto-isolate", () => {
    const patterns = Array.from(
      { length: 10 },
      (_, i) => `(?<![\\p{L}\\p{N}])entity${i}[\\p{L}\\p{N}]{1,20}(?![\\p{L}\\p{N}])`,
    );

    const ts = new TextSearch(patterns, { maxAlternations: 50 });
    const engines = Reflect.get(ts, "engines");
    const regexEngines = engines.filter((engine: { type: string }) => engine.type === "regex");

    expect(regexEngines).toHaveLength(patterns.length);
    expect(regexEngines.flatMap((engine: { indexMap: number[] }) => engine.indexMap)).toHaveLength(
      patterns.length,
    );
  });

  test("regexChunkSize opts into bounded shared chunks", () => {
    const patterns = Array.from({ length: 100 }, (_, i) => `field${i}\\s*:\\s*\\d+`);

    const ts = new TextSearch(patterns, {
      maxAlternations: 50,
      regexChunkSize: 32,
    });
    const engines = Reflect.get(ts, "engines");
    const regexEngines = engines.filter((engine: { type: string }) => engine.type === "regex");

    expect(regexEngines).toHaveLength(4);
    expect(regexEngines.flatMap((engine: { indexMap: number[] }) => engine.indexMap)).toHaveLength(
      patterns.length,
    );
  });

  test("single regex slots infer mandatory leading literal prefilters", () => {
    const ts = new TextSearch(["(?<!\\w)DE[\\s\\-./]?\\d{9}(?!\\w)"]);
    const engines = Reflect.get(ts, "engines");

    expect(engines[0]?.prefilter).toBeDefined();
    expect(ts.findIter("CZ123456789")).toEqual([]);
    expect(ts.findIter("DE123456789").map((match) => match.text)).toEqual(["DE123456789"]);
  });

  test("leading literal prefilters avoid optional and alternating prefixes", () => {
    expect(new TextSearch(["AB?C"]).findIter("AC").map((match) => match.text)).toEqual(["AC"]);
    expect(new TextSearch(["DE|FR"]).findIter("FR").map((match) => match.text)).toEqual(["FR"]);
  });

  test("pattern indices preserved after split", () => {
    const titles = Array.from({ length: 80 }, (_, i) => `t${i}`).join("|");

    const ts = new TextSearch(
      [
        "first",
        `(?:${titles})`, // isolated (>50 alts)
        "third",
      ],
      { maxAlternations: 50 },
    );

    const matches = ts.findIter("first t42 third");
    const patterns = matches.map((m) => m.pattern);

    // Original indices should be 0, 1, 2
    expect(patterns).toContain(0);
    expect(patterns).toContain(1);
    expect(patterns).toContain(2);
  });

  test("lazy isolated regex skips build when prefilter misses", () => {
    const terms = Array.from({ length: 80 }, (_, i) => `secret${i}`).join("|");
    const ts = new TextSearch([
      {
        pattern: `(?:${terms})\\s+\\d+`,
        lazy: true,
        prefilterAny: ["secret"],
      },
    ]);
    const engines = Reflect.get(ts, "engines");
    const slot = engines[0]!;

    expect(slot.rs).toBeUndefined();
    expect(ts.findIter("public 123")).toEqual([]);
    expect(slot.rs).toBeUndefined();

    const matches = ts.findIter("secret42 123");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.text).toBe("secret42 123");
    expect(slot.rs).toBeDefined();
  });

  test("small lazy regex skips shared eager build", () => {
    const ts = new TextSearch([
      "public",
      {
        pattern: "EUR\\s+\\d+",
        lazy: true,
        prefilterAny: ["EUR"],
      },
    ]);
    const engines = Reflect.get(ts, "engines");
    const lazySlot = engines.find((engine: { build?: unknown; indexMap: number[]; rs?: unknown }) =>
      engine.indexMap.includes(1),
    );

    expect(lazySlot?.build).toBeDefined();
    expect(lazySlot?.rs).toBeUndefined();
    expect(ts.findIter("public 123")).toEqual([
      {
        pattern: 0,
        start: 0,
        end: 6,
        text: "public",
      },
    ]);
    expect(lazySlot?.rs).toBeUndefined();

    const matches = ts.findIter("public EUR 42");
    expect(matches.map((match) => match.pattern)).toContain(1);
    expect(lazySlot?.rs).toBeDefined();
  });

  test("all-literal string sets use identity AC mapping", () => {
    const ts = new TextSearch(["alpha", "beta", "gamma"], {
      allLiteral: true,
      wholeWords: true,
      caseInsensitive: true,
      overlapStrategy: "all",
    });
    const engines = Reflect.get(ts, "engines");

    expect(engines).toHaveLength(1);
    expect(engines[0]!.type).toBe("ac");
    expect(engines[0]!.identityMap).toBe(true);
    expect(engines[0]!.patternCount).toBe(3);
    expect(ts.findIter("ALPHA beta alphabet").map((match) => match.pattern)).toEqual([0, 1]);
  });

  test("large all-literal whole-word sets split without changing global selection", () => {
    const patterns = Array.from({ length: 120_001 }, (_, index) => `term-${index}`);
    patterns[0] = "alpha";
    patterns[40_000] = "alpha beta";

    const ts = new TextSearch(patterns, {
      allLiteral: true,
      wholeWords: true,
      caseInsensitive: true,
      overlapStrategy: "all",
    });
    const engines = Reflect.get(ts, "engines");

    expect(engines).toHaveLength(1);
    expect(engines[0]!.type).toBe("split-ac");
    expect(ts.findIter("alpha beta")).toEqual([
      {
        pattern: 0,
        start: 0,
        end: 5,
        text: "alpha",
      },
      {
        pattern: 40_000,
        start: 0,
        end: 10,
        text: "alpha beta",
      },
    ]);
  });
});

// ─── Options ────────────────────────────────

describe("options", () => {
  test("unicodeBoundaries default true", () => {
    const ts = new TextSearch(["\\bp\\b"]);
    // Unicode \b: p inside čáp is not a word boundary
    expect(ts.findIter("čáp")).toHaveLength(0);
  });

  test("unicodeBoundaries false", () => {
    const ts = new TextSearch(["\\bp\\b"], {
      unicodeBoundaries: false,
    });
    // ASCII \b: č is not ASCII word char → boundary
    expect(ts.findIter("čáp")).toHaveLength(1);
  });

  test("wholeWords", () => {
    const ts = new TextSearch(["test"], {
      wholeWords: true,
    });
    expect(ts.findIter("testing")).toHaveLength(0);
    expect(ts.findIter("a test b")).toHaveLength(1);
  });
});

// ─── Fuzzy matching ──────────────────────────

describe("fuzzy matching", () => {
  test("fuzzy pattern matches with edit distance", () => {
    const ts = new TextSearch([{ pattern: "Smith", distance: 1 }, "exact"]);
    const matches = ts.findIter("Smi1h and exact here");
    const texts = matches.map((m) => m.text);
    expect(texts).toContain("Smi1h");
    expect(texts).toContain("exact");

    // distance is preserved on fuzzy matches
    const fuzzyMatch = matches.find((m) => m.text === "Smi1h");
    expect(fuzzyMatch!.distance).toBe(1);

    // exact matches have no distance
    const exactMatch = matches.find((m) => m.text === "exact");
    expect(exactMatch!.distance).toBeUndefined();
  });

  test("fuzzy pattern indices preserved", () => {
    const ts = new TextSearch(["literal", { pattern: "Novak", distance: 1 }, "\\d+"]);
    const matches = ts.findIter("literal Nowak 42");
    const byPattern = new Map(matches.map((m) => [m.pattern, m.text]));
    expect(byPattern.get(0)).toBe("literal");
    expect(byPattern.get(1)).toBe("Nowak");
    expect(byPattern.get(2)).toBe("42");
  });

  test("fuzzy with auto distance", () => {
    const ts = new TextSearch([{ pattern: "Gaislerova", distance: "auto" }]);
    // auto: 10 chars → distance 2
    expect(ts.isMatch("Gais1erova")).toBe(true);
  });

  test("fuzzy named patterns", () => {
    const ts = new TextSearch([
      {
        pattern: "Praha",
        distance: 1,
        name: "city",
      },
    ]);
    const matches = ts.findIter("Praha here");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.name).toBe("city");
    expect(matches[0]!.text).toBe("Praha");
  });

  test("replaceAll with mixed fuzzy + exact", () => {
    const ts = new TextSearch([{ pattern: "Smith", distance: 1 }, "exact"]);
    const result = ts.replaceAll("Smi1h and exact", ["[NAME]", "[WORD]"]);
    expect(result).toBe("[NAME] and [WORD]");
  });

  test("case-insensitive prefilter folds like the engine", () => {
    // The inferred leading-literal prefilter for `(?i)search` must fold like
    // the regex engine. U+017F (long s) folds to `s` under Unicode simple case
    // folding, so the engine matches `ſearch`. A `toLowerCase`-based prefilter
    // would leave the long s unchanged and wrongly skip the regex.
    const ts = new TextSearch(["(?i)search"]);
    const matches = ts.findIter("ſearch");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.start).toBe(0);
  });
});
