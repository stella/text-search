#![allow(
  clippy::expect_used,
  clippy::missing_assert_message,
  clippy::unwrap_used
)]

use stella_text_search_core::{
  FuzzyDistance, FuzzyPattern, LiteralPattern, OverlapStrategy, PatternEntry,
  RegexPattern, TextSearch, TextSearchOptions, classify_patterns,
  count_alternations,
};

#[test]
fn routes_literal_regex_and_fuzzy_patterns() {
  let search = TextSearch::new(
    vec![
      PatternEntry::from("literal"),
      PatternEntry::Fuzzy(FuzzyPattern::new("Novak", FuzzyDistance::Exact(1))),
      PatternEntry::from(r"\d+"),
    ],
    TextSearchOptions::default(),
  )
  .unwrap();

  let matches = search.find_iter("literal Novok 123").unwrap();
  assert_eq!(
    matches
      .iter()
      .map(|found| found.pattern)
      .collect::<Vec<_>>(),
    vec![0, 1, 2]
  );
  assert_eq!(matches.get(1).and_then(|found| found.distance), Some(1));
}

#[test]
fn named_patterns_and_original_indexes_survive_routing() {
  let mut regex = RegexPattern::new(r"\d+");
  regex.name = Some(String::from("number"));
  let mut literal = LiteralPattern::new("Acme");
  literal.name = Some(String::from("org"));

  let search = TextSearch::new(
    vec![
      PatternEntry::Regex(regex),
      PatternEntry::Literal(literal),
      PatternEntry::from("unused"),
    ],
    TextSearchOptions::default(),
  )
  .unwrap();

  let matches = search.find_iter("Acme 42").unwrap();
  assert_eq!(
    matches
      .iter()
      .map(|found| (found.pattern, found.name.as_deref(), found.text.as_str()))
      .collect::<Vec<_>>(),
    vec![(1, Some("org"), "Acme"), (0, Some("number"), "42")]
  );
}

#[test]
fn which_match_and_replace_all_use_original_indexes() {
  let search = TextSearch::new(
    vec![PatternEntry::from("foo"), PatternEntry::from("bar")],
    TextSearchOptions::default(),
  )
  .unwrap();

  assert_eq!(search.which_match("foo").unwrap(), vec![0]);
  assert_eq!(
    search
      .replace_all("foo bar", &[String::from("x"), String::from("y")])
      .unwrap(),
    "x y"
  );
}

#[test]
fn find_iter_reports_byte_offsets_with_utf16_edge_variant() {
  // `ä` is 2 UTF-8 bytes but 1 UTF-16 code unit, so the two units diverge.
  let search = TextSearch::new(
    vec![PatternEntry::from("b")],
    TextSearchOptions::default(),
  )
  .unwrap();

  let bytes = search.find_iter("äb").unwrap();
  let found = bytes.first().unwrap();
  assert_eq!((found.start, found.end), (2, 3));
  assert_eq!(found.text, "b");
  // Byte offsets index the haystack directly.
  let start = usize::try_from(found.start).unwrap();
  let end = usize::try_from(found.end).unwrap();
  assert_eq!("äb".get(start..end), Some("b"));

  let utf16 = search.find_iter_utf16("äb").unwrap();
  let found16 = utf16.first().unwrap();
  assert_eq!((found16.start, found16.end), (1, 2));
  assert_eq!(found16.text, "b");
}

#[test]
fn replace_all_slices_multibyte_haystack_by_bytes() {
  let search = TextSearch::new(
    vec![PatternEntry::from("ö")],
    TextSearchOptions::default(),
  )
  .unwrap();

  assert_eq!(
    search.replace_all("aöb", &[String::from("X")]).unwrap(),
    "aXb"
  );
}

#[test]
fn literal_pattern_options_fall_back_to_global_options() {
  let search = TextSearch::new(
    vec![PatternEntry::Literal(LiteralPattern::new("alpha"))],
    TextSearchOptions {
      case_insensitive: true,
      ..TextSearchOptions::default()
    },
  )
  .unwrap();

  assert!(search.is_match("ALPHA").unwrap());
}

#[test]
fn which_match_keeps_cross_engine_overlaps() {
  let search = TextSearch::new(
    vec![
      PatternEntry::from("ab"),
      PatternEntry::Regex(RegexPattern::new("abc")),
    ],
    TextSearchOptions::default(),
  )
  .unwrap();

  assert_eq!(search.find_iter("abc").unwrap().len(), 1);
  assert_eq!(search.which_match("abc").unwrap(), vec![0, 1]);
}

#[test]
fn regex_chunking_matches_typescript_heuristics() {
  let patterns = (0..100)
    .map(|index| PatternEntry::from(format!(r"field{index}\s*:\s*\d+")))
    .collect::<Vec<_>>();
  let search = TextSearch::new(patterns, TextSearchOptions::default()).unwrap();

  let stats = search.engine_stats();
  assert!(stats.regex_slots > 1);
  assert!(stats.regex_slots < 100);
}

#[test]
fn explicit_regex_chunk_size_is_respected() {
  let patterns = (0..100)
    .map(|index| PatternEntry::from(format!(r"field{index}\s*:\s*\d+")))
    .collect::<Vec<_>>();
  let search = TextSearch::new(
    patterns,
    TextSearchOptions {
      regex_chunk_size: Some(32),
      ..TextSearchOptions::default()
    },
  )
  .unwrap();

  assert_eq!(search.engine_stats().regex_slots, 4);
}

#[test]
fn complex_regexes_are_isolated() {
  let patterns = (0..10)
    .map(|index| {
      PatternEntry::from(format!(
        r"(?<![\p{{L}}\p{{N}}])entity{index}[\p{{L}}\p{{N}}]{{1,20}}(?![\p{{L}}\p{{N}}])"
      ))
    })
    .collect::<Vec<_>>();
  let search = TextSearch::new(patterns, TextSearchOptions::default()).unwrap();

  assert_eq!(search.engine_stats().regex_slots, 10);
}

#[test]
fn lazy_regex_prefilter_skips_regex_build_when_prefilter_misses() {
  let mut regex = RegexPattern::new("(");
  regex.lazy = true;
  regex.prefilter_any.push(String::from("needle"));

  let search = TextSearch::new(
    vec![PatternEntry::Regex(regex)],
    TextSearchOptions::default(),
  )
  .unwrap();

  assert!(!search.is_match("haystack").unwrap());
  assert!(search.is_match("needle").is_err());
}

#[test]
fn non_lazy_prefilter_does_not_gate_sibling_patterns_in_shared_slot() {
  // A non-lazy regex carrying `prefilter_any` shares a chunked slot with other
  // regexes. The prefilter must not be promoted to a slot-wide gate, otherwise
  // a haystack that only matches a sibling pattern would be skipped. This
  // mirrors the TS layer, which applies explicit prefilters to lazy patterns
  // only.
  let mut prefiltered = RegexPattern::new("foo");
  prefiltered.prefilter_any.push(String::from("needle"));

  let search = TextSearch::new(
    vec![
      PatternEntry::Regex(prefiltered),
      PatternEntry::Regex(RegexPattern::new("bar")),
    ],
    TextSearchOptions::default(),
  )
  .unwrap();

  // "bar" contains neither "foo" nor the "needle" prefilter literal, yet the
  // second pattern must still match.
  let matches = search.find_iter("bar").unwrap();
  assert_eq!(
    matches
      .iter()
      .map(|found| found.pattern)
      .collect::<Vec<_>>(),
    vec![1]
  );
}

#[test]
fn all_literal_identity_sets_split_and_select_globally() {
  let mut patterns = (0..20_001)
    .map(|index| PatternEntry::from(format!("term-{index}")))
    .collect::<Vec<_>>();
  *patterns.get_mut(0).unwrap() = PatternEntry::from("alpha");
  *patterns.get_mut(20_000).unwrap() = PatternEntry::from("alpha beta");

  let search = TextSearch::new(
    patterns,
    TextSearchOptions {
      all_literal: true,
      whole_words: true,
      case_insensitive: true,
      overlap_strategy: OverlapStrategy::All,
      ..TextSearchOptions::default()
    },
  )
  .unwrap();

  let stats = search.engine_stats();
  assert_eq!(stats.split_literal_slots, 1);
  assert_eq!(stats.split_literal_engines, 2);
  let matches = search.find_iter("ALPHA beta").unwrap();
  assert_eq!(
    matches
      .iter()
      .map(|found| (found.pattern, found.text.as_str()))
      .collect::<Vec<_>>(),
    vec![(0, "ALPHA"), (20_000, "ALPHA beta")]
  );
}

#[test]
fn literal_overlap_all_returns_same_start_matches() {
  let search = TextSearch::new(
    [
      PatternEntry::from("Alice"),
      PatternEntry::from("Alice Smith"),
    ],
    TextSearchOptions {
      whole_words: true,
      overlap_strategy: OverlapStrategy::All,
      all_literal: true,
      ..TextSearchOptions::default()
    },
  )
  .unwrap();

  let matches = search.find_iter("Alice Smith signed").unwrap();
  assert_eq!(
    matches
      .iter()
      .map(|found| (found.pattern, found.start, found.end, found.text.as_str()))
      .collect::<Vec<_>>(),
    vec![(0, 0, 5, "Alice"), (1, 0, 11, "Alice Smith")]
  );
}

#[test]
fn explicit_literal_overlap_all_returns_same_start_matches() {
  let search = TextSearch::new(
    [
      PatternEntry::Literal(LiteralPattern {
        pattern: String::from("Alice"),
        name: None,
        case_insensitive: None,
        whole_words: Some(true),
      }),
      PatternEntry::Literal(LiteralPattern {
        pattern: String::from("Alice Smith"),
        name: None,
        case_insensitive: None,
        whole_words: Some(true),
      }),
    ],
    TextSearchOptions {
      overlap_strategy: OverlapStrategy::All,
      ..TextSearchOptions::default()
    },
  )
  .unwrap();

  let matches = search.find_iter("Alice Smith signed").unwrap();
  assert_eq!(
    matches
      .iter()
      .map(|found| (found.pattern, found.start, found.end, found.text.as_str()))
      .collect::<Vec<_>>(),
    vec![(0, 0, 5, "Alice"), (1, 0, 11, "Alice Smith")]
  );
}

#[test]
fn count_alternations_ignores_escaped_and_class_pipes() {
  assert_eq!(count_alternations("a|b|c"), 3);
  assert_eq!(count_alternations(r"a\|b"), 1);
  assert_eq!(count_alternations("[a|b]"), 1);
  assert_eq!(count_alternations("(a|(b|c))|d"), 2);
}

#[test]
fn classify_patterns_preserves_metadata() {
  let mut regex = RegexPattern::new("x|y");
  regex.name = Some(String::from("test"));
  let classified =
    classify_patterns(&[PatternEntry::Regex(regex)], false).unwrap();

  let pattern = classified.first().unwrap();
  assert_eq!(pattern.alternation_count, 2);
  assert_eq!(pattern.original_index, 0);
  assert_eq!(pattern.name.as_deref(), Some("test"));
  assert!(!pattern.is_literal);
}

#[test]
fn case_insensitive_prefilter_uses_engine_case_folding() {
  // The inferred leading-literal prefilter for `(?i)search` must fold like the
  // regex engine. U+017F (long s) folds to `s` under Unicode simple case
  // folding, so the engine matches `ſearch`. A `to_lowercase`-based prefilter
  // would leave the long s unchanged and wrongly skip the regex, a false
  // negative. Routing case-insensitive prefilters through Aho-Corasick keeps
  // the gate consistent with the engine.
  let search = TextSearch::new(
    vec![PatternEntry::from("(?i)search")],
    TextSearchOptions::default(),
  )
  .unwrap();

  let matches = search.find_iter("\u{017F}earch").unwrap();
  assert_eq!(matches.len(), 1);
  assert_eq!(matches.first().map(|found| found.start), Some(0));
}

#[test]
fn lazy_regex_prefilter_regex_gates_engine_build() {
  // `prefilter_regex` is a secondary gate: the regex engine is only evaluated
  // when the prefilter regex also matches. The pattern `(` is invalid, so a
  // gate miss must short-circuit without building the engine, and a gate hit
  // must surface the build error. Mirrors the TS `prefilterRegex.test` gate.
  let mut regex = RegexPattern::new("(");
  regex.lazy = true;
  regex.prefilter_regex = Some(String::from(r"\d{3}"));

  let search = TextSearch::new(
    vec![PatternEntry::Regex(regex)],
    TextSearchOptions::default(),
  )
  .unwrap();

  assert!(!search.is_match("no digits here").unwrap());
  assert!(search.is_match("year 123").is_err());
}

#[test]
fn lazy_regex_prefilter_any_and_regex_are_combined() {
  // When both prefilters are present they form an AND gate: the engine runs
  // only if the literal prefilter and the regex prefilter both match.
  let mut regex = RegexPattern::new("(");
  regex.lazy = true;
  regex.prefilter_any.push(String::from("token"));
  regex.prefilter_regex = Some(String::from(r"\d{3}"));

  let search = TextSearch::new(
    vec![PatternEntry::Regex(regex)],
    TextSearchOptions::default(),
  )
  .unwrap();

  // Literal present but regex misses: gated out, no build.
  assert!(!search.is_match("token only").unwrap());
  // Regex matches but literal missing: gated out, no build.
  assert!(!search.is_match("123 only").unwrap());
  // Both present: gate opens and the invalid engine build surfaces.
  assert!(search.is_match("token 123").is_err());
}
