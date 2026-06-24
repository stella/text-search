use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::{error, fmt};

use stella_aho_corasick_core as aho_core;
use stella_fuzzy_search_core as fuzzy_core;
use stella_regex_set_core as regex_core;

pub type Result<T> = std::result::Result<T, Error>;

const AUTO_REGEX_CHUNK_MAX_SIZE: usize = 16;
const AUTO_REGEX_CHUNK_COMPLEXITY_BUDGET: u32 = 6;
const AUTO_REGEX_ISOLATE_COMPLEXITY: u32 = 7;
const SPLIT_IDENTITY_AC_CHUNK_SIZE: usize = 20_000;
const SPLIT_IDENTITY_AC_MIN_PATTERNS: usize = SPLIT_IDENTITY_AC_CHUNK_SIZE;
const MATCH_FIELDS: usize = 3;
const FUZZY_MATCH_FIELDS: usize = 4;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
  BuildLiteral(String),
  BuildRegex(String),
  BuildFuzzy(String),
  InvalidPackedSearchResult { engine: SearchEngine, len: usize },
  PatternIndexOutOfRange { index: usize },
  PatternIndexNotAddressable { pattern: u32 },
  InvalidUtf16Offset { offset: u32 },
  ByteOffsetOutOfRange { offset: usize },
  InvalidUtf8Span { start: usize, end: usize },
  ReplacementCountMismatch { expected: usize, actual: usize },
  MissingReplacement { pattern: u32 },
}

impl fmt::Display for Error {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::BuildLiteral(reason) => {
        write!(formatter, "Failed to build literal engine: {reason}")
      }
      Self::BuildRegex(reason) => {
        write!(formatter, "Failed to build regex engine: {reason}")
      }
      Self::BuildFuzzy(reason) => {
        write!(formatter, "Failed to build fuzzy engine: {reason}")
      }
      Self::InvalidPackedSearchResult { engine, len } => write!(
        formatter,
        "{engine} returned an invalid packed search result with length {len}"
      ),
      Self::PatternIndexOutOfRange { index } => {
        write!(formatter, "Pattern index exceeds u32 range: {index}")
      }
      Self::PatternIndexNotAddressable { pattern } => {
        write!(formatter, "Pattern index is not addressable: {pattern}")
      }
      Self::InvalidUtf16Offset { offset } => {
        write!(formatter, "Invalid UTF-16 offset: {offset}")
      }
      Self::ByteOffsetOutOfRange { offset } => {
        write!(formatter, "Byte offset exceeds u32 range: {offset}")
      }
      Self::InvalidUtf8Span { start, end } => {
        write!(formatter, "Invalid UTF-8 span: {start}..{end}")
      }
      Self::ReplacementCountMismatch { expected, actual } => {
        write!(formatter, "Expected {expected} replacements, got {actual}")
      }
      Self::MissingReplacement { pattern } => {
        write!(formatter, "Missing replacement for pattern {pattern}")
      }
    }
  }
}

impl error::Error for Error {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchEngine {
  Literal,
  Regex,
  Fuzzy,
}

impl fmt::Display for SearchEngine {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      Self::Literal => formatter.write_str("literal"),
      Self::Regex => formatter.write_str("regex"),
      Self::Fuzzy => formatter.write_str("fuzzy"),
    }
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PatternEntry {
  Auto(String),
  Regex(RegexPattern),
  Literal(LiteralPattern),
  Fuzzy(FuzzyPattern),
}

impl From<&str> for PatternEntry {
  fn from(value: &str) -> Self {
    Self::Auto(value.to_owned())
  }
}

impl From<String> for PatternEntry {
  fn from(value: String) -> Self {
    Self::Auto(value)
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegexPattern {
  pub pattern: String,
  pub name: Option<String>,
  pub lazy: bool,
  pub prefilter_any: Vec<String>,
  pub prefilter_case_insensitive: Option<bool>,
  /// Optional secondary regex prefilter (source string, inline flags such as
  /// `(?i)` allowed). Mirrors the TS `prefilterRegex` `RegExp` gate: the slot's
  /// regex engine is skipped unless this pattern also matches. Lazy patterns
  /// only, matching the TS layer.
  pub prefilter_regex: Option<String>,
}

impl RegexPattern {
  #[must_use]
  pub fn new(pattern: impl Into<String>) -> Self {
    Self {
      pattern: pattern.into(),
      name: None,
      lazy: false,
      prefilter_any: Vec::new(),
      prefilter_case_insensitive: None,
      prefilter_regex: None,
    }
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiteralPattern {
  pub pattern: String,
  pub name: Option<String>,
  pub case_insensitive: Option<bool>,
  pub whole_words: Option<bool>,
}

impl LiteralPattern {
  #[must_use]
  pub fn new(pattern: impl Into<String>) -> Self {
    Self {
      pattern: pattern.into(),
      name: None,
      case_insensitive: None,
      whole_words: None,
    }
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FuzzyPattern {
  pub pattern: String,
  pub name: Option<String>,
  pub distance: FuzzyDistance,
}

impl FuzzyPattern {
  #[must_use]
  pub fn new(pattern: impl Into<String>, distance: FuzzyDistance) -> Self {
    Self {
      pattern: pattern.into(),
      name: None,
      distance,
    }
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FuzzyDistance {
  Auto,
  Exact(u8),
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum FuzzyMetric {
  #[default]
  Levenshtein,
  DamerauLevenshtein,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum OverlapStrategy {
  #[default]
  Longest,
  All,
}

#[allow(clippy::struct_excessive_bools)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TextSearchOptions {
  pub unicode_boundaries: bool,
  pub whole_words: bool,
  pub max_alternations: u32,
  pub regex_chunk_size: Option<usize>,
  pub fuzzy_metric: FuzzyMetric,
  pub normalize_diacritics: bool,
  pub case_insensitive: bool,
  pub overlap_strategy: OverlapStrategy,
  pub all_literal: bool,
}

impl Default for TextSearchOptions {
  fn default() -> Self {
    Self {
      unicode_boundaries: true,
      whole_words: false,
      max_alternations: 50,
      regex_chunk_size: None,
      fuzzy_metric: FuzzyMetric::Levenshtein,
      normalize_diacritics: false,
      case_insensitive: false,
      overlap_strategy: OverlapStrategy::Longest,
      all_literal: false,
    }
  }
}

/// A match with UTF-8 byte offsets.
///
/// `start`/`end` are byte indices into the haystack, so `&haystack[start..end]`
/// is the matched span with no conversion. This is the native unit for Rust
/// consumers; use [`TextSearch::find_iter_utf16`] when offsets must index a
/// UTF-16 string (e.g. at a JavaScript boundary).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Match {
  pub pattern: u32,
  pub start: u32,
  pub end: u32,
  pub text: String,
  pub name: Option<String>,
  pub distance: Option<u32>,
}

/// A match with UTF-16 code-unit offsets.
///
/// Derived from [`Match`] via [`TextSearch::find_iter_utf16`] for consumers that
/// index UTF-16 strings. Rust consumers should prefer [`Match`] (byte offsets);
/// converting to UTF-16 costs one extra linear pass over the haystack.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Utf16Match {
  pub pattern: u32,
  pub start: u32,
  pub end: u32,
  pub text: String,
  pub name: Option<String>,
  pub distance: Option<u32>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct EngineStats {
  pub literal_slots: usize,
  pub split_literal_slots: usize,
  pub split_literal_engines: usize,
  pub regex_slots: usize,
  pub fuzzy_slots: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClassifiedPattern {
  pub original_index: u32,
  pub pattern: String,
  pub name: Option<String>,
  pub alternation_count: u32,
  pub is_literal: bool,
  pub fuzzy_distance: Option<FuzzyDistance>,
  pub ac_options: Option<LiteralPatternOptions>,
  pub regex_options: Option<RegexOptions>,
  pub regex_complexity: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LiteralPatternOptions {
  pub case_insensitive: Option<bool>,
  pub whole_words: Option<bool>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct LiteralOptions {
  pub case_insensitive: bool,
  pub whole_words: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RegexOptions {
  pub lazy: bool,
  pub prefilter_any: Vec<String>,
  pub prefilter_case_insensitive: Option<bool>,
  pub prefilter_regex: Option<String>,
}

pub struct TextSearch {
  engines: Vec<EngineSlot>,
  pattern_count: usize,
  overlap_strategy: OverlapStrategy,
}

enum EngineSlot {
  Literal(LiteralSlot),
  SplitLiteral(SplitLiteralSlot),
  Regex(RegexSlot),
  Fuzzy(FuzzySlot),
}

struct LiteralSlot {
  engine: aho_core::AhoCorasick,
  index_map: Vec<u32>,
  name_map: Vec<Option<String>>,
  identity_map: bool,
}

struct SplitLiteralSlot {
  engines: Vec<SplitLiteralEngine>,
}

struct SplitLiteralEngine {
  engine: aho_core::AhoCorasick,
  pattern_offset: u32,
}

struct RegexSlot {
  engine: RegexEngine,
  prefilter: Option<LiteralPrefilter>,
  prefilter_regex: Option<Box<regex_core::RegexSet>>,
  index_map: Vec<u32>,
  name_map: Vec<Option<String>>,
}

enum RegexEngine {
  Eager(Box<regex_core::RegexSet>),
  Lazy {
    patterns: Vec<String>,
    options: regex_core::Options,
    cell: OnceLock<Box<regex_core::RegexSet>>,
  },
}

struct FuzzySlot {
  engine: fuzzy_core::FuzzySearch,
  index_map: Vec<u32>,
  name_map: Vec<Option<String>>,
}

enum LiteralPrefilter {
  Single { needle: String },
  Many(aho_core::AhoCorasick),
}

impl TextSearch {
  pub fn new(
    patterns: impl IntoIterator<Item = PatternEntry>,
    options: TextSearchOptions,
  ) -> Result<Self> {
    let patterns = patterns.into_iter().collect::<Vec<_>>();
    let pattern_count = patterns.len();
    let mut engines = Vec::new();

    if options.all_literal
      && all_auto_patterns(&patterns)
      && !patterns.is_empty()
    {
      engines.push(build_identity_literal_engine(&patterns, options)?);
      return Ok(Self {
        engines,
        pattern_count,
        overlap_strategy: options.overlap_strategy,
      });
    }

    let classified = classify_patterns(&patterns, options.all_literal)?;
    let mut fuzzy = Vec::new();
    let mut literals = Vec::new();
    let mut shared_regex = Vec::new();
    let mut isolated_regex = Vec::new();

    for pattern in classified {
      if pattern.fuzzy_distance.is_some() {
        fuzzy.push(pattern);
      } else if pattern.is_literal {
        literals.push(pattern);
      } else if pattern
        .regex_options
        .as_ref()
        .is_some_and(|regex_options| regex_options.lazy)
        || pattern.alternation_count > options.max_alternations
      {
        isolated_regex.push(pattern);
      } else {
        shared_regex.push(pattern);
      }
    }

    if !fuzzy.is_empty() {
      engines.push(EngineSlot::Fuzzy(build_fuzzy_engine(fuzzy, options)?));
    }

    for (literal_options, group) in group_literals(literals, options) {
      engines.push(EngineSlot::Literal(build_literal_engine(
        group,
        literal_options,
      )?));
    }

    for chunk in
      chunk_shared_regex_patterns(shared_regex, options.regex_chunk_size)
    {
      engines
        .push(EngineSlot::Regex(build_regex_engine(chunk, options, None)?));
    }

    for pattern in isolated_regex {
      // Mirror the TS layer: isolated regexes carry their own prefilter
      // options. Passing `Some(..)` (even when the pattern has no explicit
      // options) marks this as the isolated path, which suppresses the
      // shared-path leading-literal prefilter inference.
      let lazy_options =
        Some(pattern.regex_options.clone().unwrap_or_default());
      engines.push(EngineSlot::Regex(build_regex_engine(
        vec![pattern],
        options,
        lazy_options,
      )?));
    }

    Ok(Self {
      engines,
      pattern_count,
      overlap_strategy: options.overlap_strategy,
    })
  }

  #[must_use]
  pub const fn len(&self) -> usize {
    self.pattern_count
  }

  #[must_use]
  pub const fn is_empty(&self) -> bool {
    self.pattern_count == 0
  }

  #[must_use]
  pub fn engine_stats(&self) -> EngineStats {
    let mut stats = EngineStats::default();
    for engine in &self.engines {
      match engine {
        EngineSlot::Literal(_) => {
          stats.literal_slots = stats.literal_slots.saturating_add(1);
        }
        EngineSlot::SplitLiteral(slot) => {
          stats.split_literal_slots =
            stats.split_literal_slots.saturating_add(1);
          stats.split_literal_engines = stats
            .split_literal_engines
            .saturating_add(slot.engines.len());
        }
        EngineSlot::Regex(_) => {
          stats.regex_slots = stats.regex_slots.saturating_add(1);
        }
        EngineSlot::Fuzzy(_) => {
          stats.fuzzy_slots = stats.fuzzy_slots.saturating_add(1);
        }
      }
    }
    stats
  }

  pub fn is_match(&self, haystack: &str) -> Result<bool> {
    for engine in &self.engines {
      if engine_is_match(engine, haystack)? {
        return Ok(true);
      }
    }
    Ok(false)
  }

  pub fn find_iter(&self, haystack: &str) -> Result<Vec<Match>> {
    let mut matches = Vec::new();
    for engine in &self.engines {
      matches.extend(engine_find_iter(engine, haystack)?);
    }

    if matches.len() <= 1 {
      return Ok(matches);
    }
    if self.overlap_strategy == OverlapStrategy::All {
      matches.sort_by_key(|found| found.start);
      return Ok(matches);
    }

    Ok(merge_and_select(matches))
  }

  /// Like [`find_iter`](Self::find_iter) but reports UTF-16 code-unit offsets.
  ///
  /// For consumers that index UTF-16 strings (e.g. a JavaScript boundary).
  /// Rust consumers should prefer [`find_iter`](Self::find_iter); this variant
  /// costs one additional linear pass to remap byte offsets to UTF-16.
  pub fn find_iter_utf16(&self, haystack: &str) -> Result<Vec<Utf16Match>> {
    let matches = self.find_iter(haystack)?;
    let mut converter = ByteToUtf16Offset::new(haystack);
    let mut out = Vec::with_capacity(matches.len());
    for found in matches {
      let start = converter.find(haystack, byte_index(found.start))?;
      let end = converter.find(haystack, byte_index(found.end))?;
      out.push(Utf16Match {
        pattern: found.pattern,
        start,
        end,
        text: found.text,
        name: found.name,
        distance: found.distance,
      });
    }
    Ok(out)
  }

  pub fn which_match(&self, haystack: &str) -> Result<Vec<u32>> {
    let mut matches = Vec::new();
    for engine in &self.engines {
      matches.extend(
        engine_find_iter(engine, haystack)?
          .into_iter()
          .map(|found| found.pattern),
      );
    }
    matches.sort_unstable();
    matches.dedup();
    Ok(matches)
  }

  pub fn replace_all(
    &self,
    haystack: &str,
    replacements: &[String],
  ) -> Result<String> {
    if replacements.len() != self.pattern_count {
      return Err(Error::ReplacementCountMismatch {
        expected: self.pattern_count,
        actual: replacements.len(),
      });
    }

    let mut matches = Vec::new();
    for engine in &self.engines {
      matches.extend(engine_find_iter(engine, haystack)?);
    }
    let matches = merge_and_select(matches);

    let mut result = String::with_capacity(haystack.len());
    let mut last_byte = 0;
    for found in matches {
      let start = byte_index(found.start);
      let end = byte_index(found.end);
      result.push_str(str_span(haystack, last_byte, start)?);
      let replacement_index = usize::try_from(found.pattern).map_err(|_| {
        Error::PatternIndexNotAddressable {
          pattern: found.pattern,
        }
      })?;
      let Some(replacement) = replacements.get(replacement_index) else {
        return Err(Error::MissingReplacement {
          pattern: found.pattern,
        });
      };
      result.push_str(replacement);
      last_byte = end;
    }
    result.push_str(str_span(haystack, last_byte, haystack.len())?);
    Ok(result)
  }
}

pub fn classify_patterns(
  entries: &[PatternEntry],
  all_literal: bool,
) -> Result<Vec<ClassifiedPattern>> {
  let mut result = Vec::with_capacity(entries.len());
  for (index, entry) in entries.iter().enumerate() {
    let original_index = pattern_index(index)?;
    result.push(match entry {
      PatternEntry::Auto(pattern) => {
        let alternation_count = if all_literal {
          0
        } else {
          count_alternations(pattern)
        };
        ClassifiedPattern {
          original_index,
          pattern: pattern.clone(),
          name: None,
          alternation_count,
          is_literal: all_literal || is_literal_pattern(pattern),
          fuzzy_distance: None,
          ac_options: None,
          regex_options: None,
          regex_complexity: score_regex_complexity(pattern, alternation_count),
        }
      }
      PatternEntry::Regex(pattern) => {
        let alternation_count = count_alternations(&pattern.pattern);
        ClassifiedPattern {
          original_index,
          pattern: pattern.pattern.clone(),
          name: pattern.name.clone(),
          alternation_count,
          is_literal: false,
          fuzzy_distance: None,
          ac_options: None,
          regex_options: Some(RegexOptions {
            lazy: pattern.lazy,
            prefilter_any: pattern.prefilter_any.clone(),
            prefilter_case_insensitive: pattern.prefilter_case_insensitive,
            prefilter_regex: pattern.prefilter_regex.clone(),
          }),
          regex_complexity: score_regex_complexity(
            &pattern.pattern,
            alternation_count,
          ),
        }
      }
      PatternEntry::Literal(pattern) => ClassifiedPattern {
        original_index,
        pattern: pattern.pattern.clone(),
        name: pattern.name.clone(),
        alternation_count: 0,
        is_literal: true,
        fuzzy_distance: None,
        ac_options: (pattern.case_insensitive.is_some()
          || pattern.whole_words.is_some())
        .then_some(LiteralPatternOptions {
          case_insensitive: pattern.case_insensitive,
          whole_words: pattern.whole_words,
        }),
        regex_options: None,
        regex_complexity: 0,
      },
      PatternEntry::Fuzzy(pattern) => ClassifiedPattern {
        original_index,
        pattern: pattern.pattern.clone(),
        name: pattern.name.clone(),
        alternation_count: 0,
        is_literal: false,
        fuzzy_distance: Some(pattern.distance),
        ac_options: None,
        regex_options: None,
        regex_complexity: 0,
      },
    });
  }
  Ok(result)
}

#[must_use]
pub fn is_literal_pattern(pattern: &str) -> bool {
  !pattern.is_empty()
    && !pattern.chars().any(|ch| {
      matches!(
        ch,
        '\\'
          | '.'
          | '^'
          | '$'
          | '*'
          | '+'
          | '?'
          | '{'
          | '}'
          | '('
          | ')'
          | '['
          | ']'
          | '|'
      )
    })
}

#[must_use]
pub fn count_alternations(pattern: &str) -> u32 {
  let mut depth = 0_u32;
  let mut in_class = false;
  let mut escaped = false;
  let mut max_count = 1_u32;
  let mut current_count = 1_u32;
  let mut stack = Vec::<u32>::new();

  for ch in pattern.chars() {
    if escaped {
      escaped = false;
      continue;
    }
    if ch == '\\' {
      escaped = true;
      continue;
    }
    if ch == '[' {
      in_class = true;
      continue;
    }
    if ch == ']' {
      in_class = false;
      continue;
    }
    if in_class {
      continue;
    }

    match ch {
      '(' => {
        stack.push(current_count);
        current_count = 1;
        depth = depth.saturating_add(1);
      }
      ')' if depth > 0 => {
        max_count = max_count.max(current_count);
        current_count = stack.pop().unwrap_or(1);
        depth = depth.saturating_sub(1);
      }
      '|' => current_count = current_count.saturating_add(1),
      _ => {}
    }
  }

  max_count.max(current_count)
}

#[must_use]
pub fn score_regex_complexity(pattern: &str, alternation_count: u32) -> u32 {
  let mut score = 1_u32;

  if pattern.len() > 80 {
    score = score.saturating_add(2);
  }
  if pattern.len() > 160 {
    score = score.saturating_add(2);
  }
  if alternation_count > 1 {
    score = score.saturating_add(if alternation_count >= 4 { 2 } else { 1 });
  }
  if pattern.contains(r"\p{") {
    score = score.saturating_add(3);
  }
  if has_lookaround(pattern) {
    score = score.saturating_add(4);
  }
  if has_regex_anchor_or_boundary(pattern) {
    score = score.saturating_add(1);
  }
  if pattern.contains(".*") || pattern.contains(".+") {
    score = score.saturating_add(3);
  }
  if has_quantified_char_class(pattern) {
    score = score.saturating_add(2);
  }
  if has_count_quantifier(pattern) {
    score = score.saturating_add(2);
  }
  if has_quantified_class_or_shorthand(pattern) {
    score = score.saturating_add(1);
  }

  score
}

fn all_auto_patterns(patterns: &[PatternEntry]) -> bool {
  patterns
    .iter()
    .all(|pattern| matches!(pattern, PatternEntry::Auto(_)))
}

fn group_literals(
  patterns: Vec<ClassifiedPattern>,
  options: TextSearchOptions,
) -> BTreeMap<LiteralOptions, Vec<ClassifiedPattern>> {
  let mut groups = BTreeMap::new();
  for pattern in patterns {
    let overrides = pattern.ac_options;
    let key = LiteralOptions {
      case_insensitive: overrides
        .and_then(|value| value.case_insensitive)
        .unwrap_or(options.case_insensitive),
      whole_words: overrides
        .and_then(|value| value.whole_words)
        .unwrap_or(options.whole_words),
    };
    groups.entry(key).or_insert_with(Vec::new).push(pattern);
  }
  groups
}

fn chunk_shared_regex_patterns(
  patterns: Vec<ClassifiedPattern>,
  explicit_chunk_size: Option<usize>,
) -> Vec<Vec<ClassifiedPattern>> {
  if let Some(chunk_size) = explicit_chunk_size {
    let chunk_size = chunk_size.max(1);
    let mut chunks = Vec::new();
    let mut current = Vec::new();
    for pattern in patterns {
      current.push(pattern);
      if current.len() == chunk_size {
        chunks.push(std::mem::take(&mut current));
      }
    }
    if !current.is_empty() {
      chunks.push(current);
    }
    return chunks;
  }

  let mut chunks = Vec::new();
  let mut current = Vec::new();
  let mut current_complexity = 0_u32;
  for pattern in patterns {
    let complexity = pattern.regex_complexity;
    if complexity >= AUTO_REGEX_ISOLATE_COMPLEXITY {
      flush_chunk(&mut chunks, &mut current);
      current_complexity = 0;
      chunks.push(vec![pattern]);
      continue;
    }
    let exceeds_size = current.len() >= AUTO_REGEX_CHUNK_MAX_SIZE;
    let exceeds_complexity = !current.is_empty()
      && current_complexity.saturating_add(complexity)
        > AUTO_REGEX_CHUNK_COMPLEXITY_BUDGET;
    if exceeds_size || exceeds_complexity {
      flush_chunk(&mut chunks, &mut current);
      current_complexity = 0;
    }
    current_complexity = current_complexity.saturating_add(complexity);
    current.push(pattern);
  }
  flush_chunk(&mut chunks, &mut current);
  chunks
}

fn flush_chunk(
  chunks: &mut Vec<Vec<ClassifiedPattern>>,
  current: &mut Vec<ClassifiedPattern>,
) {
  if !current.is_empty() {
    chunks.push(std::mem::take(current));
  }
}

fn build_identity_literal_engine(
  patterns: &[PatternEntry],
  options: TextSearchOptions,
) -> Result<EngineSlot> {
  let pattern_strings = patterns
    .iter()
    .filter_map(|pattern| match pattern {
      PatternEntry::Auto(value) => Some(value.clone()),
      _ => None,
    })
    .collect::<Vec<_>>();

  if options.whole_words
    && options.unicode_boundaries
    && pattern_strings.len() >= SPLIT_IDENTITY_AC_MIN_PATTERNS
  {
    let mut engines = Vec::new();
    for (chunk_index, chunk) in pattern_strings
      .chunks(SPLIT_IDENTITY_AC_CHUNK_SIZE)
      .enumerate()
    {
      let offset = chunk_index
        .checked_mul(SPLIT_IDENTITY_AC_CHUNK_SIZE)
        .ok_or(Error::PatternIndexOutOfRange { index: usize::MAX })?;
      engines.push(SplitLiteralEngine {
        engine: build_aho(chunk.to_vec(), options.into())?,
        pattern_offset: pattern_index(offset)?,
      });
    }
    return Ok(EngineSlot::SplitLiteral(SplitLiteralSlot { engines }));
  }

  Ok(EngineSlot::Literal(LiteralSlot {
    engine: build_aho(pattern_strings, options.into())?,
    index_map: Vec::new(),
    name_map: Vec::new(),
    identity_map: true,
  }))
}

fn build_literal_engine(
  patterns: Vec<ClassifiedPattern>,
  options: LiteralOptions,
) -> Result<LiteralSlot> {
  let mut values = Vec::with_capacity(patterns.len());
  let mut index_map = Vec::with_capacity(patterns.len());
  let mut name_map = Vec::with_capacity(patterns.len());
  for pattern in patterns {
    values.push(pattern.pattern);
    index_map.push(pattern.original_index);
    name_map.push(pattern.name);
  }

  Ok(LiteralSlot {
    engine: build_aho(values, options)?,
    index_map,
    name_map,
    identity_map: false,
  })
}

/// Builds a regex slot.
///
/// `lazy_options` mirrors the TS layer's `lazyOptions`: `None` marks the shared
/// chunk path, `Some(..)` marks the isolated path. Explicit `prefilter_any`
/// filters apply only to lazy patterns (always isolated, single-pattern slots),
/// so a prefilter can never gate an unrelated pattern sharing the slot. The
/// leading-literal prefilter is inferred only on the shared path for
/// single-pattern chunks.
fn build_regex_engine(
  patterns: Vec<ClassifiedPattern>,
  options: TextSearchOptions,
  lazy_options: Option<RegexOptions>,
) -> Result<RegexSlot> {
  let inferred_prefilter = if lazy_options.is_none() && patterns.len() == 1 {
    patterns
      .first()
      .and_then(|pattern| infer_leading_literal_prefilter(&pattern.pattern))
      .map(|prefilter| {
        build_literal_prefilter(
          &[prefilter.literal],
          prefilter.case_insensitive || options.case_insensitive,
        )
      })
      .transpose()?
  } else {
    None
  };

  let mut values = Vec::with_capacity(patterns.len());
  let mut index_map = Vec::with_capacity(patterns.len());
  let mut name_map = Vec::with_capacity(patterns.len());
  for pattern in patterns {
    values.push(pattern.pattern);
    index_map.push(pattern.original_index);
    name_map.push(pattern.name);
  }

  let engine_options = regex_core::Options {
    whole_words: options.whole_words,
    unicode_boundaries: options.unicode_boundaries,
  };

  let (engine, prefilter, prefilter_regex) = match lazy_options {
    Some(lazy_options) if lazy_options.lazy => {
      let prefilter = if lazy_options.prefilter_any.is_empty() {
        None
      } else {
        Some(build_literal_prefilter(
          &lazy_options.prefilter_any,
          lazy_options
            .prefilter_case_insensitive
            .unwrap_or(options.case_insensitive),
        )?)
      };
      let prefilter_regex = lazy_options
        .prefilter_regex
        .map(build_prefilter_regex)
        .transpose()?
        .map(Box::new);
      let engine = RegexEngine::Lazy {
        patterns: values,
        options: engine_options,
        cell: OnceLock::new(),
      };
      (engine, prefilter, prefilter_regex)
    }
    _ => {
      let engine = RegexEngine::Eager(Box::new(
        regex_core::RegexSet::new(values, engine_options)
          .map_err(|error| Error::BuildRegex(error.to_string()))?,
      ));
      (engine, inferred_prefilter, None)
    }
  };

  Ok(RegexSlot {
    engine,
    prefilter,
    prefilter_regex,
    index_map,
    name_map,
  })
}

fn regex_slot_engine(slot: &RegexSlot) -> Result<&regex_core::RegexSet> {
  match &slot.engine {
    RegexEngine::Eager(engine) => Ok(engine.as_ref()),
    RegexEngine::Lazy {
      patterns,
      options,
      cell,
    } => {
      if let Some(engine) = cell.get() {
        return Ok(engine.as_ref());
      }

      let engine = regex_core::RegexSet::new(patterns.clone(), *options)
        .map_err(|error| Error::BuildRegex(error.to_string()))?;
      _ = cell.set(Box::new(engine));
      cell.get().map(Box::as_ref).ok_or_else(|| {
        Error::BuildRegex(String::from("Lazy regex engine was not initialized"))
      })
    }
  }
}

struct LeadingLiteralPrefilter {
  literal: String,
  case_insensitive: bool,
}

fn infer_leading_literal_prefilter(
  pattern: &str,
) -> Option<LeadingLiteralPrefilter> {
  let (case_insensitive, mut index) = if pattern.starts_with("(?i)") {
    (true, 4)
  } else {
    (false, 0)
  };

  while let Some((ch, next)) = char_at(pattern, index) {
    if ch == '^' {
      index = next;
      continue;
    }

    if ch == '\\' {
      let (escaped, after_escape) = char_at(pattern, next)?;
      if matches!(escaped, 'b' | 'B' | 'A' | 'Z' | 'z') {
        index = after_escape;
        continue;
      }
    }

    if starts_with_at(pattern, index, "(?=")
      || starts_with_at(pattern, index, "(?!")
      || starts_with_at(pattern, index, "(?<=")
      || starts_with_at(pattern, index, "(?<!")
    {
      index = find_regex_group_end(pattern, index)?;
      continue;
    }

    break;
  }

  let mut literal = String::new();
  while let Some((ch, next)) = char_at(pattern, index) {
    if ch == '\\' {
      let Some((escaped, after_escape)) = char_at(pattern, next) else {
        break;
      };
      if escaped.is_ascii_alphabetic() {
        break;
      }
      literal.push(escaped);
      index = after_escape;
      continue;
    }

    if is_regex_metachar(ch) {
      break;
    }

    literal.push(ch);
    index = next;
  }

  let suffix = pattern.get(index..).unwrap_or_default();
  if suffix.starts_with('|') {
    return None;
  }
  if suffix.starts_with('?')
    || suffix.starts_with('*')
    || suffix.starts_with("{0")
  {
    _ = literal.pop();
  }

  (literal.encode_utf16().count() >= 2).then_some(LeadingLiteralPrefilter {
    literal,
    case_insensitive,
  })
}

fn find_regex_group_end(pattern: &str, start: usize) -> Option<usize> {
  let mut depth = 0_u32;
  let mut in_class = false;
  let mut index = start;

  while let Some((ch, next)) = char_at(pattern, index) {
    if ch == '\\' {
      index =
        char_at(pattern, next).map_or(next, |(_, after_escape)| after_escape);
      continue;
    }
    if ch == '[' && !in_class {
      in_class = true;
      index = next;
      continue;
    }
    if ch == ']' && in_class {
      in_class = false;
      index = next;
      continue;
    }
    if in_class {
      index = next;
      continue;
    }
    if ch == '(' {
      depth = depth.saturating_add(1);
      index = next;
      continue;
    }
    if ch == ')' {
      depth = depth.saturating_sub(1);
      if depth == 0 {
        return Some(next);
      }
    }
    index = next;
  }

  None
}

fn char_at(value: &str, index: usize) -> Option<(char, usize)> {
  let ch = value.get(index..)?.chars().next()?;
  Some((ch, index.saturating_add(ch.len_utf8())))
}

fn starts_with_at(value: &str, index: usize, needle: &str) -> bool {
  value
    .get(index..)
    .is_some_and(|suffix| suffix.starts_with(needle))
}

const fn is_regex_metachar(ch: char) -> bool {
  matches!(
    ch,
    '^' | '$' | '*' | '+' | '?' | '.' | '(' | ')' | '[' | ']' | '{' | '}' | '|'
  )
}

fn build_fuzzy_engine(
  patterns: Vec<ClassifiedPattern>,
  options: TextSearchOptions,
) -> Result<FuzzySlot> {
  let mut values = Vec::with_capacity(patterns.len());
  let mut index_map = Vec::with_capacity(patterns.len());
  let mut name_map = Vec::with_capacity(patterns.len());
  for pattern in patterns {
    values.push(fuzzy_core::PatternEntry {
      pattern: pattern.pattern,
      distance: match pattern.fuzzy_distance {
        Some(FuzzyDistance::Exact(value)) => Some(value),
        Some(FuzzyDistance::Auto) | None => None,
      },
    });
    index_map.push(pattern.original_index);
    name_map.push(pattern.name);
  }

  let engine = fuzzy_core::FuzzySearch::new(
    values,
    fuzzy_core::Options {
      metric: match options.fuzzy_metric {
        FuzzyMetric::Levenshtein => fuzzy_core::Metric::Levenshtein,
        FuzzyMetric::DamerauLevenshtein => {
          fuzzy_core::Metric::DamerauLevenshtein
        }
      },
      normalize_diacritics: options.normalize_diacritics,
      unicode_boundaries: options.unicode_boundaries,
      whole_words: options.whole_words,
      case_insensitive: options.case_insensitive,
    },
  )
  .map_err(|error| Error::BuildFuzzy(error.to_string()))?;

  Ok(FuzzySlot {
    engine,
    index_map,
    name_map,
  })
}

fn build_literal_prefilter(
  literals: &[String],
  case_insensitive: bool,
) -> Result<LiteralPrefilter> {
  let mut unique = Vec::<String>::new();
  for literal in literals {
    if !literal.is_empty() && !unique.contains(literal) {
      unique.push(literal.clone());
    }
  }

  // Case-insensitive matching must use the engines' Unicode simple case
  // folding, which `str::to_lowercase` does not replicate (e.g. `ſ` folds to
  // `s` yet is already lowercase). Route case-insensitive prefilters through
  // Aho-Corasick, which folds identically to the search engines; reserve the
  // single-literal fast path for the case-sensitive exact-substring check.
  if unique.len() == 1 && !case_insensitive {
    let needle = unique.pop().unwrap_or_default();
    return Ok(LiteralPrefilter::Single { needle });
  }

  build_aho(
    unique,
    LiteralOptions {
      case_insensitive,
      whole_words: false,
    },
  )
  .map(LiteralPrefilter::Many)
}

/// Builds a secondary regex prefilter gate.
///
/// Mirrors the TS `prefilterRegex.test(haystack)` check: a bare match test with
/// no whole-word wrapping, independent of the slot's own engine options.
fn build_prefilter_regex(source: String) -> Result<regex_core::RegexSet> {
  regex_core::RegexSet::new(
    vec![source],
    regex_core::Options {
      whole_words: false,
      unicode_boundaries: true,
    },
  )
  .map_err(|error| Error::BuildRegex(error.to_string()))
}

fn build_aho(
  patterns: Vec<String>,
  options: LiteralOptions,
) -> Result<aho_core::AhoCorasick> {
  aho_core::AhoCorasick::new(
    patterns,
    aho_core::Options {
      match_kind: aho_core::MatchKind::LeftmostFirst,
      case_insensitive: options.case_insensitive,
      dfa: false,
      whole_words: options.whole_words,
    },
  )
  .map_err(|error| Error::BuildLiteral(error.to_string()))
}

fn engine_is_match(engine: &EngineSlot, haystack: &str) -> Result<bool> {
  match engine {
    EngineSlot::Literal(slot) => slot
      .engine
      .is_match(haystack)
      .map_err(|error| Error::BuildLiteral(error.to_string())),
    EngineSlot::SplitLiteral(slot) => {
      for split_engine in &slot.engines {
        if split_engine
          .engine
          .is_match(haystack)
          .map_err(|error| Error::BuildLiteral(error.to_string()))?
        {
          return Ok(true);
        }
      }
      Ok(false)
    }
    EngineSlot::Regex(slot) => {
      if !regex_prefilter_matches(slot, haystack)? {
        return Ok(false);
      }
      Ok(regex_slot_engine(slot)?.is_match(haystack))
    }
    EngineSlot::Fuzzy(slot) => slot
      .engine
      .is_match(haystack)
      .map_err(|error| Error::BuildFuzzy(error.to_string())),
  }
}

fn engine_find_iter(engine: &EngineSlot, haystack: &str) -> Result<Vec<Match>> {
  match engine {
    EngineSlot::Literal(slot) => extend_triple_matches(
      SearchEngine::Literal,
      haystack,
      &slot
        .engine
        .find_iter_packed(haystack)
        .map_err(|error| Error::BuildLiteral(error.to_string()))?,
      &Remap::Mapped {
        index_map: &slot.index_map,
        name_map: &slot.name_map,
        identity: slot.identity_map,
      },
    ),
    EngineSlot::SplitLiteral(slot) => split_literal_find_iter(slot, haystack),
    EngineSlot::Regex(slot) => {
      if !regex_prefilter_matches(slot, haystack)? {
        return Ok(Vec::new());
      }
      extend_triple_matches(
        SearchEngine::Regex,
        haystack,
        &regex_slot_engine(slot)?
          .find_iter_packed(haystack)
          .map_err(|error| Error::BuildRegex(error.to_string()))?,
        &Remap::Mapped {
          index_map: &slot.index_map,
          name_map: &slot.name_map,
          identity: false,
        },
      )
    }
    EngineSlot::Fuzzy(slot) => extend_fuzzy_matches(
      haystack,
      &slot
        .engine
        .find_iter_packed(haystack)
        .map_err(|error| Error::BuildFuzzy(error.to_string()))?,
      &slot.index_map,
      &slot.name_map,
    ),
  }
}

fn split_literal_find_iter(
  slot: &SplitLiteralSlot,
  haystack: &str,
) -> Result<Vec<Match>> {
  let mut matches = Vec::new();
  for engine in &slot.engines {
    let packed = engine
      .engine
      .find_overlapping_iter_packed(haystack)
      .map_err(|error| Error::BuildLiteral(error.to_string()))?;
    matches.extend(extend_triple_matches(
      SearchEngine::Literal,
      haystack,
      &packed,
      &Remap::Offset {
        pattern_offset: engine.pattern_offset,
      },
    )?);
  }
  Ok(select_leftmost_longest_matches(matches))
}

#[derive(Clone, Copy)]
enum Remap<'a> {
  Mapped {
    index_map: &'a [u32],
    name_map: &'a [Option<String>],
    identity: bool,
  },
  Offset {
    pattern_offset: u32,
  },
}

fn extend_triple_matches(
  engine: SearchEngine,
  haystack: &str,
  packed: &[u32],
  remap: &Remap<'_>,
) -> Result<Vec<Match>> {
  let chunks = packed.chunks_exact(MATCH_FIELDS);
  if !chunks.remainder().is_empty() {
    return Err(Error::InvalidPackedSearchResult {
      engine,
      len: packed.len(),
    });
  }

  let mut matches = Vec::with_capacity(chunks.len());
  let mut converter = Utf16ToByteOffset::new(haystack);
  for chunk in chunks {
    let [local_pattern, start, end] = chunk else {
      return Err(Error::InvalidPackedSearchResult {
        engine,
        len: packed.len(),
      });
    };
    let (pattern, name) = remap_pattern(remap, *local_pattern)?;
    let start_byte = converter.find(haystack, *start)?;
    let end_byte = converter.find(haystack, *end)?;
    matches.push(Match {
      pattern,
      start: offset_u32(start_byte)?,
      end: offset_u32(end_byte)?,
      text: str_span(haystack, start_byte, end_byte)?.to_owned(),
      name,
      distance: None,
    });
  }
  Ok(matches)
}

fn extend_fuzzy_matches(
  haystack: &str,
  packed: &[u32],
  index_map: &[u32],
  name_map: &[Option<String>],
) -> Result<Vec<Match>> {
  let chunks = packed.chunks_exact(FUZZY_MATCH_FIELDS);
  if !chunks.remainder().is_empty() {
    return Err(Error::InvalidPackedSearchResult {
      engine: SearchEngine::Fuzzy,
      len: packed.len(),
    });
  }

  let mut matches = Vec::with_capacity(chunks.len());
  let mut converter = Utf16ToByteOffset::new(haystack);
  for chunk in chunks {
    let [local_pattern, start, end, distance] = chunk else {
      return Err(Error::InvalidPackedSearchResult {
        engine: SearchEngine::Fuzzy,
        len: packed.len(),
      });
    };
    let pattern_index = usize::try_from(*local_pattern).map_err(|_| {
      Error::PatternIndexNotAddressable {
        pattern: *local_pattern,
      }
    })?;
    let Some(pattern) = index_map.get(pattern_index).copied() else {
      return Err(Error::InvalidPackedSearchResult {
        engine: SearchEngine::Fuzzy,
        len: packed.len(),
      });
    };
    let start_byte = converter.find(haystack, *start)?;
    let end_byte = converter.find(haystack, *end)?;
    matches.push(Match {
      pattern,
      start: offset_u32(start_byte)?,
      end: offset_u32(end_byte)?,
      text: str_span(haystack, start_byte, end_byte)?.to_owned(),
      name: name_map.get(pattern_index).cloned().flatten(),
      distance: Some(*distance),
    });
  }
  Ok(matches)
}

fn remap_pattern(
  remap: &Remap<'_>,
  local_pattern: u32,
) -> Result<(u32, Option<String>)> {
  match remap {
    Remap::Offset { pattern_offset } => {
      Ok((pattern_offset.saturating_add(local_pattern), None))
    }
    Remap::Mapped {
      index_map,
      name_map,
      identity,
    } => {
      if *identity {
        return Ok((local_pattern, None));
      }
      let pattern_index = usize::try_from(local_pattern).map_err(|_| {
        Error::PatternIndexNotAddressable {
          pattern: local_pattern,
        }
      })?;
      let Some(pattern) = index_map.get(pattern_index).copied() else {
        return Err(Error::PatternIndexNotAddressable {
          pattern: local_pattern,
        });
      };
      Ok((pattern, name_map.get(pattern_index).cloned().flatten()))
    }
  }
}

fn regex_prefilter_matches(slot: &RegexSlot, haystack: &str) -> Result<bool> {
  if let Some(prefilter) = &slot.prefilter {
    let literal_matches = match prefilter {
      LiteralPrefilter::Single { needle } => haystack.contains(needle),
      LiteralPrefilter::Many(engine) => engine
        .is_match(haystack)
        .map_err(|error| Error::BuildLiteral(error.to_string()))?,
    };
    if !literal_matches {
      return Ok(false);
    }
  }
  if let Some(prefilter_regex) = &slot.prefilter_regex
    && !prefilter_regex.is_match(haystack)
  {
    return Ok(false);
  }
  Ok(true)
}

fn merge_and_select(mut matches: Vec<Match>) -> Vec<Match> {
  if matches.len() <= 1 {
    return matches;
  }
  matches.sort_by(|left, right| {
    left.start.cmp(&right.start).then_with(|| {
      let left_len = left.end.saturating_sub(left.start);
      let right_len = right.end.saturating_sub(right.start);
      right_len.cmp(&left_len)
    })
  });

  let mut selected = Vec::new();
  let mut last_end = 0;
  for found in matches {
    if found.start >= last_end {
      last_end = found.end;
      selected.push(found);
    }
  }
  selected
}

fn select_leftmost_longest_matches(mut matches: Vec<Match>) -> Vec<Match> {
  if matches.is_empty() {
    return Vec::new();
  }
  matches.sort_by(|left, right| {
    left
      .start
      .cmp(&right.start)
      .then_with(|| {
        let left_len = left.end.saturating_sub(left.start);
        let right_len = right.end.saturating_sub(right.start);
        right_len.cmp(&left_len)
      })
      .then_with(|| left.pattern.cmp(&right.pattern))
  });

  let mut selected = Vec::new();
  let mut cursor = 0;
  let mut index = 0;
  while index < matches.len() {
    let Some(found) = matches.get(index) else {
      break;
    };
    let start = found.start;
    if start < cursor {
      index = index.saturating_add(1);
      continue;
    }

    let mut best = found;
    index = index.saturating_add(1);
    while let Some(candidate) = matches
      .get(index)
      .filter(|candidate| candidate.start == start)
    {
      let candidate_len = candidate.end.saturating_sub(candidate.start);
      let best_len = best.end.saturating_sub(best.start);
      if candidate_len > best_len
        || (candidate_len == best_len && candidate.pattern < best.pattern)
      {
        best = candidate;
      }
      index = index.saturating_add(1);
    }
    cursor = best.end;
    selected.push(best.clone());
  }
  selected
}

fn has_lookaround(pattern: &str) -> bool {
  pattern.contains("(?=")
    || pattern.contains("(?!")
    || pattern.contains("(?<=")
    || pattern.contains("(?<!")
}

fn has_regex_anchor_or_boundary(pattern: &str) -> bool {
  pattern.contains(r"\b")
    || pattern.contains(r"\B")
    || pattern.contains(r"\A")
    || pattern.contains(r"\Z")
    || pattern.contains(r"\z")
}

fn has_quantified_char_class(pattern: &str) -> bool {
  let mut chars = pattern.chars().peekable();
  let mut in_class = false;
  let mut escaped = false;

  while let Some(ch) = chars.next() {
    if escaped {
      escaped = false;
      continue;
    }
    if ch == '\\' {
      escaped = true;
      continue;
    }
    if ch == '[' {
      in_class = true;
      continue;
    }
    if ch == ']' && in_class {
      in_class = false;
      if chars.peek().copied().is_some_and(is_quantifier_start) {
        return true;
      }
    }
  }

  false
}

fn has_count_quantifier(pattern: &str) -> bool {
  let mut chars = pattern.chars().peekable();
  while let Some(ch) = chars.next() {
    if ch != '{' {
      continue;
    }

    let mut has_quantifier_body = false;
    while let Some(next) = chars.peek().copied() {
      if next == '}' {
        _ = chars.next();
        if has_quantifier_body {
          return true;
        }
        break;
      }
      if next.is_ascii_digit() || next == ',' {
        has_quantifier_body = true;
        _ = chars.next();
        continue;
      }
      break;
    }
  }

  false
}

fn has_quantified_class_or_shorthand(pattern: &str) -> bool {
  if has_quantified_char_class(pattern) {
    return true;
  }

  let mut chars = pattern.chars().peekable();
  while let Some(ch) = chars.next() {
    if ch != '\\' {
      continue;
    }
    let Some(next) = chars.next() else {
      break;
    };
    if matches!(next, 'd' | 'D' | 's' | 'S' | 'w' | 'W')
      && chars.peek().copied().is_some_and(is_quantifier_start)
    {
      return true;
    }
    if next == 'p'
      && consume_unicode_class(&mut chars)
      && chars.peek().copied().is_some_and(is_quantifier_start)
    {
      return true;
    }
  }

  false
}

fn consume_unicode_class(
  chars: &mut std::iter::Peekable<std::str::Chars<'_>>,
) -> bool {
  if chars.next_if_eq(&'{').is_none() {
    return false;
  }
  for ch in chars.by_ref() {
    if ch == '}' {
      return true;
    }
  }
  false
}

const fn is_quantifier_start(ch: char) -> bool {
  matches!(ch, '*' | '+' | '{')
}

fn str_span(haystack: &str, start: usize, end: usize) -> Result<&str> {
  haystack
    .get(start..end)
    .ok_or(Error::InvalidUtf8Span { start, end })
}

/// Narrows a `usize` byte offset to the `u32` used by [`Match`].
fn offset_u32(value: usize) -> Result<u32> {
  u32::try_from(value)
    .map_err(|_| Error::ByteOffsetOutOfRange { offset: value })
}

/// Widens a [`Match`] `u32` byte offset to a `usize` index. `u32` always fits
/// `usize` on supported (>= 32-bit pointer) targets; the fallback keeps the
/// result in range so [`str_span`] reports a clean error otherwise.
fn byte_index(value: u32) -> usize {
  usize::try_from(value).unwrap_or(usize::MAX)
}

/// Stateful UTF-16 to byte offset translator.
///
/// Engine matches arrive sorted by start offset, so a single forward pass over
/// the haystack resolves every offset in `O(N)` total instead of rescanning
/// from the start for each lookup (`O(N * M)`). Offsets that move backwards
/// (not expected, but cheap to guard) reset the cursor so the result stays
/// correct regardless of call order.
struct Utf16ToByteOffset<'a> {
  char_indices: std::str::CharIndices<'a>,
  current_byte: usize,
  current_utf16: u32,
}

impl<'a> Utf16ToByteOffset<'a> {
  fn new(haystack: &'a str) -> Self {
    Self {
      char_indices: haystack.char_indices(),
      current_byte: 0,
      current_utf16: 0,
    }
  }

  fn find(&mut self, haystack: &'a str, target: u32) -> Result<usize> {
    if target < self.current_utf16 {
      self.char_indices = haystack.char_indices();
      self.current_byte = 0;
      self.current_utf16 = 0;
    }
    while self.current_utf16 < target {
      let Some((byte_pos, ch)) = self.char_indices.next() else {
        break;
      };
      self.current_byte = byte_pos.saturating_add(ch.len_utf8());
      self.current_utf16 = self
        .current_utf16
        .saturating_add(if ch.len_utf16() == 1 { 1 } else { 2 });
    }
    if self.current_utf16 == target {
      Ok(self.current_byte)
    } else {
      Err(Error::InvalidUtf16Offset { offset: target })
    }
  }
}

/// Stateful byte to UTF-16 offset translator: the inverse of
/// [`Utf16ToByteOffset`], used only on the UTF-16 edge path
/// ([`TextSearch::find_iter_utf16`]). Same single forward pass with a
/// backwards-move guard.
struct ByteToUtf16Offset<'a> {
  char_indices: std::str::CharIndices<'a>,
  current_byte: usize,
  current_utf16: u32,
}

impl<'a> ByteToUtf16Offset<'a> {
  fn new(haystack: &'a str) -> Self {
    Self {
      char_indices: haystack.char_indices(),
      current_byte: 0,
      current_utf16: 0,
    }
  }

  fn find(&mut self, haystack: &'a str, target: usize) -> Result<u32> {
    if target < self.current_byte {
      self.char_indices = haystack.char_indices();
      self.current_byte = 0;
      self.current_utf16 = 0;
    }
    while self.current_byte < target {
      let Some((byte_pos, ch)) = self.char_indices.next() else {
        break;
      };
      self.current_byte = byte_pos.saturating_add(ch.len_utf8());
      self.current_utf16 = self
        .current_utf16
        .saturating_add(if ch.len_utf16() == 1 { 1 } else { 2 });
    }
    if self.current_byte == target {
      Ok(self.current_utf16)
    } else {
      Err(Error::InvalidUtf8Span {
        start: target,
        end: target,
      })
    }
  }
}

fn pattern_index(index: usize) -> Result<u32> {
  u32::try_from(index).map_err(|_| Error::PatternIndexOutOfRange { index })
}

impl From<TextSearchOptions> for LiteralOptions {
  fn from(value: TextSearchOptions) -> Self {
    Self {
      case_insensitive: value.case_insensitive,
      whole_words: value.whole_words,
    }
  }
}
