#![allow(
  clippy::expect_used,
  clippy::missing_assert_message,
  clippy::unwrap_used
)]

use stella_text_search_core::{
  Error, FuzzyDistance, FuzzyPattern, LiteralPattern, OverlapStrategy,
  PatternEntry, PreparedTextSearchArtifacts, RegexPattern, TextSearch,
  TextSearchOptions, classify_patterns, count_alternations,
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
fn prepared_artifacts_match_direct_search() {
  let mut literal = LiteralPattern::new("Alice");
  literal.name = Some(String::from("person"));
  let patterns = vec![
    PatternEntry::Literal(literal),
    PatternEntry::from(r"\d+"),
    PatternEntry::from("signed"),
  ];
  let options = TextSearchOptions {
    case_insensitive: true,
    whole_words: true,
    ..TextSearchOptions::default()
  };

  let artifacts =
    TextSearch::prepare_artifacts(patterns.clone(), options).unwrap();
  assert!(
    !artifacts.aho_automata.is_empty(),
    "literal engines should produce prepared Aho artifacts"
  );
  let direct = TextSearch::new(patterns.clone(), options).unwrap();
  let prepared =
    TextSearch::with_prepared_artifacts(patterns, options, &artifacts).unwrap();
  let haystack = "Alice signed 123";

  assert_eq!(
    prepared.find_iter(haystack).unwrap(),
    direct.find_iter(haystack).unwrap()
  );
  assert_eq!(
    prepared.which_match(haystack).unwrap(),
    direct.which_match(haystack).unwrap()
  );
}

#[test]
fn prepared_artifacts_capture_regex_sets() {
  let mut account = RegexPattern::new(r"ACC-\d{3}");
  account.name = Some(String::from("account"));
  let patterns = vec![
    PatternEntry::from("Alice"),
    PatternEntry::Regex(account),
    PatternEntry::from(r"\b\d{4}-\d{2}-\d{2}\b"),
  ];
  let options = TextSearchOptions {
    case_insensitive: true,
    whole_words: true,
    ..TextSearchOptions::default()
  };

  let artifacts =
    TextSearch::prepare_artifacts(patterns.clone(), options).unwrap();
  assert!(
    !artifacts.regex_sets.is_empty(),
    "regex engines should produce prepared regex artifacts"
  );

  let direct = TextSearch::new(patterns.clone(), options).unwrap();
  let prepared =
    TextSearch::with_prepared_artifacts(patterns, options, &artifacts).unwrap();
  let haystack = "alice ACC-123 signed 2026-06-26";

  assert_eq!(
    prepared.find_iter(haystack).unwrap(),
    direct.find_iter(haystack).unwrap()
  );
  assert_eq!(
    prepared
      .replace_all(
        haystack,
        &[
          String::from("[PERSON]"),
          String::from("[ACCOUNT]"),
          String::from("[DATE]"),
        ],
      )
      .unwrap(),
    direct
      .replace_all(
        haystack,
        &[
          String::from("[PERSON]"),
          String::from("[ACCOUNT]"),
          String::from("[DATE]"),
        ],
      )
      .unwrap()
  );
}

#[test]
fn prepared_artifacts_capture_lazy_regex_sets() {
  let mut regex = RegexPattern::new(r"token-\d+");
  regex.lazy = true;
  regex.prefilter_any.push(String::from("token"));
  regex.prefilter_regex = Some(String::from(r"\d+"));
  let patterns = vec![PatternEntry::Regex(regex)];
  let options = TextSearchOptions::default();

  let artifacts =
    TextSearch::prepare_artifacts(patterns.clone(), options).unwrap();
  assert_eq!(
    artifacts.regex_sets.len(),
    2,
    "lazy regex with a regex prefilter should prepare both regex sets"
  );

  let direct = TextSearch::new(patterns.clone(), options).unwrap();
  let prepared =
    TextSearch::with_prepared_artifacts(patterns, options, &artifacts).unwrap();

  assert_eq!(
    prepared.find_iter("token-42").unwrap(),
    direct.find_iter("token-42").unwrap()
  );
  assert!(!prepared.is_match("token").unwrap());
}

#[test]
fn prepared_artifacts_preserve_ascii_boundaries() {
  let patterns = vec![PatternEntry::from("idea")];
  let options = TextSearchOptions {
    all_literal: true,
    whole_words: true,
    unicode_boundaries: false,
    ..TextSearchOptions::default()
  };
  let artifacts =
    TextSearch::prepare_artifacts(patterns.clone(), options).unwrap();
  let search =
    TextSearch::with_prepared_artifacts(patterns, options, &artifacts).unwrap();

  let matches = search.find_iter("нетidea").unwrap();
  assert_eq!(matches.len(), 1);
  assert_eq!(
    matches
      .first()
      .map(|found| (found.start, found.end, found.text.as_str())),
    Some((6, 10, "idea"))
  );
  assert!(
    search.find_iter("xidea").unwrap().is_empty(),
    "ASCII boundary mode should reject ASCII word neighbors"
  );
}

#[test]
fn prepared_artifacts_reject_missing_extra_and_mismatched_aho() {
  let options = TextSearchOptions {
    all_literal: true,
    ..TextSearchOptions::default()
  };
  let base_patterns = vec![PatternEntry::from("alpha")];
  let artifacts =
    TextSearch::prepare_artifacts(base_patterns.clone(), options).unwrap();
  let empty_artifacts = PreparedTextSearchArtifacts::default();

  let missing = TextSearch::with_prepared_artifacts(
    base_patterns.clone(),
    options,
    &empty_artifacts,
  );
  assert!(
    matches!(missing, Err(Error::PreparedAhoArtifactMissing { .. })),
    "missing prepared Aho artifact should fail"
  );

  let mut extra = artifacts.clone();
  let duplicate = artifacts.aho_automata.first().unwrap().clone();
  extra.aho_automata.push(duplicate);
  let extra_result =
    TextSearch::with_prepared_artifacts(base_patterns, options, &extra);
  assert!(
    matches!(
      extra_result,
      Err(Error::PreparedAhoArtifactCountMismatch { .. })
    ),
    "extra prepared Aho artifact should fail"
  );
}

#[test]
fn prepared_artifacts_reject_stale_same_count_aho() {
  let options = TextSearchOptions {
    all_literal: true,
    ..TextSearchOptions::default()
  };
  let artifacts =
    TextSearch::prepare_artifacts(vec![PatternEntry::from("alpha")], options)
      .unwrap();

  let stale = TextSearch::with_prepared_artifacts(
    vec![PatternEntry::from("beta")],
    options,
    &artifacts,
  );
  assert!(
    matches!(stale, Err(Error::PreparedAhoFingerprintMismatch { .. })),
    "same-count stale prepared Aho artifacts should fail"
  );

  let mismatched_count = TextSearch::with_prepared_artifacts(
    vec![PatternEntry::from("alpha"), PatternEntry::from("beta")],
    options,
    &artifacts,
  );
  assert!(
    matches!(
      mismatched_count,
      Err(Error::PreparedAhoPatternCountMismatch { .. })
    ),
    "wrong prepared Aho pattern count should fail"
  );
}

#[test]
fn prepared_artifacts_reject_missing_extra_and_stale_regex() {
  let options = TextSearchOptions::default();
  let patterns = vec![PatternEntry::from(r"\d+")];
  let artifacts =
    TextSearch::prepare_artifacts(patterns.clone(), options).unwrap();
  assert_eq!(artifacts.regex_sets.len(), 1);

  let mut missing = artifacts.clone();
  missing.regex_sets.clear();
  let missing_result =
    TextSearch::with_prepared_artifacts(patterns.clone(), options, &missing);
  assert!(
    matches!(
      missing_result,
      Err(Error::PreparedRegexArtifactMissing { .. })
    ),
    "missing prepared regex artifact should fail"
  );

  let mut extra = artifacts.clone();
  let duplicate = artifacts.regex_sets.first().unwrap().clone();
  extra.regex_sets.push(duplicate);
  let extra_result =
    TextSearch::with_prepared_artifacts(patterns, options, &extra);
  assert!(
    matches!(
      extra_result,
      Err(Error::PreparedRegexArtifactCountMismatch { .. })
    ),
    "extra prepared regex artifact should fail"
  );

  let stale = TextSearch::with_prepared_artifacts(
    vec![PatternEntry::from(r"[a-z]+")],
    options,
    &artifacts,
  );
  assert!(
    matches!(stale, Err(Error::BuildRegex(_))),
    "same-count stale prepared regex artifacts should fail"
  );
}

#[test]
fn prepared_artifacts_roundtrip_bytes() {
  let options = TextSearchOptions {
    all_literal: true,
    case_insensitive: true,
    whole_words: true,
    ..TextSearchOptions::default()
  };
  let patterns = vec![PatternEntry::from("alpha"), PatternEntry::from("beta")];
  let artifacts =
    TextSearch::prepare_artifacts(patterns.clone(), options).unwrap();
  let bytes = artifacts.to_bytes().unwrap();
  let decoded = PreparedTextSearchArtifacts::from_bytes(&bytes).unwrap();

  assert_eq!(decoded, artifacts);

  let search =
    TextSearch::with_prepared_artifacts(patterns, options, &decoded).unwrap();
  assert_eq!(search.find_iter("alpha beta").unwrap().len(), 2);
}

#[test]
fn prepared_regex_artifacts_roundtrip_bytes() {
  let options = TextSearchOptions {
    case_insensitive: true,
    whole_words: true,
    ..TextSearchOptions::default()
  };
  let patterns = vec![
    PatternEntry::from(r"\b[A-Z]{2}-\d{4}\b"),
    PatternEntry::from("approved"),
  ];
  let artifacts =
    TextSearch::prepare_artifacts(patterns.clone(), options).unwrap();
  assert!(!artifacts.regex_sets.is_empty());

  let bytes = artifacts.to_bytes().unwrap();
  let decoded = PreparedTextSearchArtifacts::from_bytes(&bytes).unwrap();
  assert_eq!(decoded, artifacts);

  let direct = TextSearch::new(patterns.clone(), options).unwrap();
  let prepared =
    TextSearch::with_prepared_artifacts(patterns, options, &decoded).unwrap();
  assert_eq!(
    prepared.find_iter("AB-1234 approved").unwrap(),
    direct.find_iter("AB-1234 approved").unwrap()
  );
}

#[test]
fn prepared_all_literal_artifacts_load_without_patterns() {
  let mut patterns = (0..20_001)
    .map(|index| PatternEntry::from(format!("term-{index}")))
    .collect::<Vec<_>>();
  *patterns.get_mut(0).unwrap() = PatternEntry::from("alpha");
  *patterns.get_mut(20_000).unwrap() = PatternEntry::from("alpha beta");
  let options = TextSearchOptions {
    all_literal: true,
    whole_words: true,
    case_insensitive: true,
    overlap_strategy: OverlapStrategy::All,
    ..TextSearchOptions::default()
  };

  let direct = TextSearch::new(patterns.clone(), options).unwrap();
  let artifacts = TextSearch::prepare_artifacts(patterns, options).unwrap();
  let prepared =
    TextSearch::with_prepared_all_literal_artifacts(options, &artifacts)
      .unwrap();

  assert_eq!(prepared.len(), direct.len());
  assert_eq!(prepared.engine_stats(), direct.engine_stats());
  assert_eq!(
    prepared.find_iter("ALPHA beta").unwrap(),
    direct.find_iter("ALPHA beta").unwrap()
  );
}

#[test]
fn prepared_all_literal_artifacts_preserve_exact_split_threshold() {
  let mut patterns = (0..20_000)
    .map(|index| PatternEntry::from(format!("term-{index}")))
    .collect::<Vec<_>>();
  *patterns.get_mut(0).unwrap() = PatternEntry::from("alpha");
  let options = TextSearchOptions {
    all_literal: true,
    whole_words: true,
    unicode_boundaries: true,
    ..TextSearchOptions::default()
  };

  let direct = TextSearch::new(patterns.clone(), options).unwrap();
  let artifacts = TextSearch::prepare_artifacts(patterns, options).unwrap();
  let prepared =
    TextSearch::with_prepared_all_literal_artifacts(options, &artifacts)
      .unwrap();

  assert_eq!(prepared.engine_stats(), direct.engine_stats());
  assert_eq!(
    prepared.find_iter("alpha").unwrap(),
    direct.find_iter("alpha").unwrap()
  );
}

#[test]
fn prepared_all_literal_artifacts_reject_literal_option_mismatch() {
  let patterns = vec![PatternEntry::from("alpha")];
  let prepare_options = TextSearchOptions {
    all_literal: true,
    whole_words: false,
    ..TextSearchOptions::default()
  };
  let artifacts =
    TextSearch::prepare_artifacts(patterns, prepare_options).unwrap();

  let load_options = TextSearchOptions {
    all_literal: true,
    whole_words: true,
    ..TextSearchOptions::default()
  };
  let loaded =
    TextSearch::with_prepared_all_literal_artifacts(load_options, &artifacts);

  assert!(
    matches!(loaded, Err(Error::PreparedAhoOptionsMismatch { .. })),
    "all-literal prepared artifacts should reject literal option drift"
  );
}

#[test]
fn prepared_all_literal_artifacts_reject_non_identity_artifacts() {
  let patterns = vec![
    PatternEntry::Fuzzy(FuzzyPattern::new("alpha", FuzzyDistance::Exact(1))),
    PatternEntry::from("beta"),
  ];
  let options = TextSearchOptions::default();
  let artifacts = TextSearch::prepare_artifacts(patterns, options).unwrap();

  let loaded =
    TextSearch::with_prepared_all_literal_artifacts(options, &artifacts);

  assert!(
    matches!(loaded, Err(Error::PreparedAhoIdentityMismatch { .. })),
    "no-pattern all-literal loading should require identity artifacts"
  );
}

#[test]
fn prepared_artifacts_reject_invalid_bytes() {
  let error =
    PreparedTextSearchArtifacts::from_bytes(b"not-valid").unwrap_err();

  assert!(
    matches!(error, Error::PreparedArtifactInvalid { .. }),
    "invalid artifact bytes should fail at the format boundary"
  );
}

#[test]
fn prepared_artifacts_reject_previous_artifact_version() {
  let mut bytes = Vec::new();
  bytes.extend_from_slice(b"TXSRCH01");
  bytes.extend_from_slice(&4u32.to_le_bytes());
  bytes.extend_from_slice(&0u32.to_le_bytes());

  let error = PreparedTextSearchArtifacts::from_bytes(&bytes).unwrap_err();

  assert!(
    matches!(error, Error::PreparedArtifactInvalid { .. }),
    "previous prepared artifact versions should fail at the format boundary"
  );
}

#[test]
fn prepared_artifacts_reject_impossible_artifact_count() {
  let mut bytes = Vec::new();
  bytes.extend_from_slice(b"TXSRCH01");
  bytes.extend_from_slice(&6u32.to_le_bytes());
  bytes.extend_from_slice(&u32::MAX.to_le_bytes());

  let error = PreparedTextSearchArtifacts::from_bytes(&bytes).unwrap_err();

  assert!(
    matches!(error, Error::PreparedArtifactInvalid { .. }),
    "impossible artifact counts should fail before allocation"
  );
}

#[test]
fn prepared_artifacts_reject_impossible_regex_artifact_count() {
  let mut bytes = Vec::new();
  bytes.extend_from_slice(b"TXSRCH01");
  bytes.extend_from_slice(&6u32.to_le_bytes());
  bytes.extend_from_slice(&0u32.to_le_bytes());
  bytes.extend_from_slice(&u32::MAX.to_le_bytes());

  let error = PreparedTextSearchArtifacts::from_bytes(&bytes).unwrap_err();

  assert!(
    matches!(error, Error::PreparedArtifactInvalid { .. }),
    "impossible regex artifact counts should fail before allocation"
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
fn warm_lazy_regex_initializes_without_prefilter_hit() {
  let mut regex = RegexPattern::new("(");
  regex.lazy = true;
  regex.prefilter_any.push(String::from("needle"));

  let search = TextSearch::new(
    vec![PatternEntry::Regex(regex)],
    TextSearchOptions::default(),
  )
  .unwrap();

  assert!(search.warm_lazy_regex().is_err());
}

#[test]
fn warm_lazy_regex_initializes_prepared_lazy_slots() {
  let mut patterns = Vec::new();
  for index in 0..8 {
    let mut regex = RegexPattern::new(format!("token{index}\\s+\\d+"));
    regex.lazy = true;
    patterns.push(PatternEntry::Regex(regex));
  }
  let options = TextSearchOptions::default();
  let artifacts =
    TextSearch::prepare_artifacts(patterns.clone(), options).unwrap();
  let search =
    TextSearch::with_prepared_artifacts(patterns, options, &artifacts).unwrap();

  assert_eq!(search.engine_stats().regex_slots, 8);
  search.warm_lazy_regex().unwrap();

  let matches = search.find_iter("before token6 42 after").unwrap();

  assert_eq!(matches.len(), 1);
  assert_eq!(matches.first().map(|match_| match_.pattern), Some(6));
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
fn regex_overlap_all_returns_same_start_matches() {
  let search = TextSearch::new(
    [
      PatternEntry::Regex(RegexPattern::new("Alice")),
      PatternEntry::Regex(RegexPattern::new("Alice Smith")),
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
fn regex_overlap_all_does_not_infer_single_pattern_prefilters() {
  let search = TextSearch::new(
    [
      PatternEntry::Regex(RegexPattern::new("Alice.*|Bob")),
      PatternEntry::Regex(RegexPattern::new("Carol")),
    ],
    TextSearchOptions {
      overlap_strategy: OverlapStrategy::All,
      ..TextSearchOptions::default()
    },
  )
  .unwrap();

  let matches = search.find_iter("Bob and Carol").unwrap();
  assert_eq!(
    matches
      .iter()
      .map(|found| (found.pattern, found.start, found.end, found.text.as_str()))
      .collect::<Vec<_>>(),
    vec![(0, 0, 3, "Bob"), (1, 8, 13, "Carol")]
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
