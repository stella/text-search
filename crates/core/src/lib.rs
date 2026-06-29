use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::Instant;
use std::{error, fmt};

use stella_aho_corasick_core as aho_core;
use stella_fuzzy_search_core as fuzzy_core;
use stella_regex_set_core as regex_core;

pub type Result<T> = std::result::Result<T, Error>;

const AUTO_REGEX_CHUNK_MAX_SIZE: usize = 16;
const AUTO_REGEX_CHUNK_COMPLEXITY_BUDGET: u32 = 6;
const AUTO_REGEX_ISOLATE_COMPLEXITY: u32 = 7;
const SPLIT_IDENTITY_AC_CHUNK_SIZE: usize = 100_000;
const SPLIT_IDENTITY_AC_MIN_PATTERNS: usize = SPLIT_IDENTITY_AC_CHUNK_SIZE;
const MATCH_FIELDS: usize = 3;
const FUZZY_MATCH_FIELDS: usize = 4;
const PREPARED_ARTIFACTS_MAGIC: &[u8; 8] = b"TXSRCH01";
const PREPARED_ARTIFACTS_VERSION: u32 = 7;
const PREPARED_AHO_ARTIFACT_MIN_BYTES: usize = std::mem::size_of::<u64>()
  + std::mem::size_of::<u8>()
  + std::mem::size_of::<u8>()
  + std::mem::size_of::<u32>();
const AHO_FINGERPRINT_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const AHO_FINGERPRINT_PRIME: u64 = 0x0100_0000_01b3;
const AHO_FINGERPRINT_SCHEMA_VERSION: u8 = 1;
const PREPARED_LITERAL_CASE_INSENSITIVE: u8 = 1 << 0;
const PREPARED_LITERAL_WHOLE_WORDS: u8 = 1 << 1;
const PREPARED_LITERAL_UNICODE_BOUNDARIES: u8 = 1 << 2;
const PREPARED_LITERAL_FLAGS_MASK: u8 = PREPARED_LITERAL_CASE_INSENSITIVE
  | PREPARED_LITERAL_WHOLE_WORDS
  | PREPARED_LITERAL_UNICODE_BOUNDARIES;
const PARALLEL_LAZY_REGEX_WARM_MIN_SLOTS: usize = 4;
const PARALLEL_FIND_MIN_ENGINES: usize = 4;
const PARALLEL_FIND_MIN_BYTES: usize = 32 * 1024;
const PARALLEL_FIND_MAX_WORKERS: usize = 4;
const PARALLEL_SPLIT_LITERAL_MIN_ENGINES: usize = 2;
const INLINE_LITERAL_PREFILTER_MAX_PATTERNS: usize = 4;
const INLINE_LITERAL_PREFILTER_MAX_BYTES: usize = 128;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Error {
  BuildLiteral(String),
  BuildRegex(String),
  BuildFuzzy(String),
  InvalidPackedSearchResult {
    engine: SearchEngine,
    len: usize,
  },
  PatternIndexOutOfRange {
    index: usize,
  },
  PatternIndexNotAddressable {
    pattern: u32,
  },
  InvalidUtf8Span {
    start: usize,
    end: usize,
  },
  PreparedAhoArtifactCountMismatch {
    expected: usize,
    actual: usize,
  },
  PreparedAhoArtifactMissing {
    index: usize,
  },
  PreparedAhoPatternCountMismatch {
    artifact: usize,
    expected: u32,
    actual: u32,
  },
  PreparedAhoFingerprintMismatch {
    artifact: usize,
  },
  PreparedAhoOptionsMismatch {
    artifact: usize,
  },
  PreparedAhoIdentityMismatch {
    artifact: usize,
  },
  PreparedRegexArtifactCountMismatch {
    expected: usize,
    actual: usize,
  },
  PreparedRegexArtifactMissing {
    index: usize,
  },
  PreparedArtifactInvalid {
    reason: String,
  },
  PreparedArtifactTooLarge {
    field: &'static str,
    len: usize,
  },
  ReplacementCountMismatch {
    expected: usize,
    actual: usize,
  },
  MissingReplacement {
    pattern: u32,
  },
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
      Self::InvalidUtf8Span { start, end } => {
        write!(formatter, "Invalid UTF-8 span: {start}..{end}")
      }
      Self::PreparedAhoArtifactCountMismatch { expected, actual } => write!(
        formatter,
        "Expected {expected} prepared Aho artifacts, got {actual}"
      ),
      Self::PreparedAhoArtifactMissing { index } => {
        write!(formatter, "Missing prepared Aho artifact at index {index}")
      }
      Self::PreparedAhoPatternCountMismatch {
        artifact,
        expected,
        actual,
      } => write!(
        formatter,
        "Prepared Aho artifact {artifact} has {actual} patterns, expected {expected}"
      ),
      Self::PreparedAhoFingerprintMismatch { artifact } => write!(
        formatter,
        "Prepared Aho artifact {artifact} does not match the requested literal patterns and options"
      ),
      Self::PreparedAhoOptionsMismatch { artifact } => write!(
        formatter,
        "Prepared Aho artifact {artifact} was built with different literal options"
      ),
      Self::PreparedAhoIdentityMismatch { artifact } => write!(
        formatter,
        "Prepared Aho artifact {artifact} was not built as an identity literal artifact"
      ),
      Self::PreparedRegexArtifactCountMismatch { expected, actual } => write!(
        formatter,
        "Expected {expected} prepared regex artifacts, got {actual}"
      ),
      Self::PreparedRegexArtifactMissing { index } => {
        write!(
          formatter,
          "Missing prepared regex artifact at index {index}"
        )
      }
      Self::PreparedArtifactInvalid { reason } => {
        write!(formatter, "Prepared artifact is invalid: {reason}")
      }
      Self::PreparedArtifactTooLarge { field, len } => write!(
        formatter,
        "Prepared artifact field '{field}' exceeds u32 length: {len}"
      ),
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
  /// Optional byte radius around literal prefilter hits for lazy single-pattern
  /// scans. Keeps broad cue words from forcing a full-haystack regex pass.
  pub prefilter_window_bytes: Option<usize>,
  pub prepared_artifact_policy: PreparedArtifactPolicy,
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
      prefilter_window_bytes: None,
      prepared_artifact_policy: PreparedArtifactPolicy::Inherit,
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

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum RegexArtifactPolicy {
  #[default]
  Include,
  Omit,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum PreparedArtifactPolicy {
  #[default]
  Inherit,
  Include,
  Omit,
}

impl PreparedArtifactPolicy {
  const fn should_capture(self, default_policy: RegexArtifactPolicy) -> bool {
    match self {
      Self::Inherit => {
        matches!(default_policy, RegexArtifactPolicy::Include)
      }
      Self::Include => true,
      Self::Omit => false,
    }
  }
}

#[allow(clippy::struct_excessive_bools)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TextSearchOptions {
  pub unicode_boundaries: bool,
  pub whole_words: bool,
  pub max_alternations: u32,
  pub regex_chunk_size: Option<usize>,
  pub regex_artifact_policy: RegexArtifactPolicy,
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
      regex_artifact_policy: RegexArtifactPolicy::Include,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EngineKind {
  Literal,
  SplitLiteral,
  Regex,
  Fuzzy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BuildStats {
  pub slot: usize,
  pub engine: EngineKind,
  pub pattern_count: usize,
  pub first_pattern: Option<u32>,
  pub last_pattern: Option<u32>,
  pub elapsed_us: u64,
  pub aho_artifact_count: usize,
  pub aho_artifact_bytes: usize,
  pub regex_artifact_count: usize,
  pub regex_artifact_bytes: usize,
  pub regex_lazy: bool,
  pub regex_prefilter: bool,
  pub regex_prefilter_regex: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FindStats {
  pub slot: usize,
  pub subslot: Option<usize>,
  pub engine: EngineKind,
  pub pattern_count: usize,
  pub first_pattern: Option<u32>,
  pub last_pattern: Option<u32>,
  pub match_count: usize,
  pub elapsed_us: u64,
}

pub struct TextSearchBuildResult {
  pub search: TextSearch,
  pub stats: Vec<BuildStats>,
}

pub struct TextSearchFindResult {
  pub matches: Vec<Match>,
  pub stats: Vec<FindStats>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PreparedTextSearchArtifacts {
  pub aho_automata: Vec<PreparedAhoArtifact>,
  pub regex_sets: Vec<PreparedRegexArtifact>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedAhoArtifact {
  pub fingerprint: u64,
  pub options: LiteralOptions,
  pub identity: bool,
  pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedRegexArtifact {
  pub bytes: Vec<u8>,
}

impl PreparedTextSearchArtifacts {
  pub fn to_bytes(&self) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(PREPARED_ARTIFACTS_MAGIC);
    write_u32(&mut bytes, PREPARED_ARTIFACTS_VERSION);
    write_u32(
      &mut bytes,
      checked_len_u32(self.aho_automata.len(), "aho_automata")?,
    );
    for artifact in &self.aho_automata {
      write_u64(&mut bytes, artifact.fingerprint);
      write_u8(&mut bytes, literal_options_to_flags(artifact.options));
      write_u8(&mut bytes, u8::from(artifact.identity));
      write_u32(
        &mut bytes,
        checked_len_u32(artifact.bytes.len(), "aho_automata.bytes")?,
      );
      bytes.extend_from_slice(&artifact.bytes);
    }
    write_u32(
      &mut bytes,
      checked_len_u32(self.regex_sets.len(), "regex_sets")?,
    );
    for artifact in &self.regex_sets {
      write_u32(
        &mut bytes,
        checked_len_u32(artifact.bytes.len(), "regex_sets.bytes")?,
      );
      bytes.extend_from_slice(&artifact.bytes);
    }
    Ok(bytes)
  }

  pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
    let mut reader = PreparedArtifactReader::new(bytes);
    let magic = reader.read_bytes(PREPARED_ARTIFACTS_MAGIC.len())?;
    if magic != PREPARED_ARTIFACTS_MAGIC {
      return Err(invalid_prepared_artifact("unexpected header"));
    }
    let version = reader.read_u32()?;
    if version != PREPARED_ARTIFACTS_VERSION {
      return Err(invalid_prepared_artifact("unsupported version"));
    }
    let count = reader.read_usize()?;
    let min_payload_len = count
      .checked_mul(PREPARED_AHO_ARTIFACT_MIN_BYTES)
      .ok_or_else(|| invalid_prepared_artifact("artifact count overflow"))?;
    if min_payload_len > reader.remaining_len() {
      return Err(invalid_prepared_artifact(
        "artifact count exceeds payload length",
      ));
    }
    let mut aho_automata = Vec::with_capacity(count);
    for _ in 0..count {
      let fingerprint = reader.read_u64()?;
      let options = literal_options_from_flags(reader.read_u8()?)?;
      let identity = read_identity_flag(reader.read_u8()?)?;
      let automaton = reader.read_len_prefixed_bytes()?.to_vec();
      aho_automata.push(PreparedAhoArtifact {
        fingerprint,
        options,
        identity,
        bytes: automaton,
      });
    }
    let regex_count = reader.read_usize()?;
    let min_regex_payload_len = regex_count
      .checked_mul(std::mem::size_of::<u32>())
      .ok_or_else(|| {
        invalid_prepared_artifact("regex artifact count overflow")
      })?;
    if min_regex_payload_len > reader.remaining_len() {
      return Err(invalid_prepared_artifact(
        "regex artifact count exceeds payload length",
      ));
    }
    let mut regex_sets = Vec::with_capacity(regex_count);
    for _ in 0..regex_count {
      regex_sets.push(PreparedRegexArtifact {
        bytes: reader.read_len_prefixed_bytes()?.to_vec(),
      });
    }
    reader.finish()?;
    Ok(Self {
      aho_automata,
      regex_sets,
    })
  }
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
  pub unicode_boundaries: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RegexOptions {
  pub lazy: bool,
  pub prefilter_any: Vec<String>,
  pub prefilter_case_insensitive: Option<bool>,
  pub prefilter_regex: Option<String>,
  pub prefilter_window_bytes: Option<usize>,
  pub prepared_artifact_policy: PreparedArtifactPolicy,
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
  overlap_strategy: OverlapStrategy,
}

struct SplitLiteralSlot {
  engines: Vec<SplitLiteralEngine>,
  overlap_strategy: OverlapStrategy,
}

struct SplitLiteralEngine {
  engine: aho_core::AhoCorasick,
  pattern_offset: u32,
}

struct RegexSlot {
  engine: RegexEngine,
  prefilter: Option<LiteralPrefilter>,
  prefilter_regex: Option<Box<regex_core::RegexSet>>,
  prefilter_window_bytes: Option<usize>,
  prefilter_window_needs_full_context: bool,
  index_map: Vec<u32>,
  name_map: Vec<Option<String>>,
}

enum RegexEngine {
  Eager(Box<regex_core::RegexSet>),
  Lazy {
    patterns: Vec<String>,
    options: regex_core::Options,
    prepared: Option<Vec<u8>>,
    cell: OnceLock<Box<regex_core::RegexSet>>,
  },
}

struct FuzzySlot {
  engine: fuzzy_core::FuzzySearch,
  index_map: Vec<u32>,
  name_map: Vec<Option<String>>,
}

enum LiteralPrefilter {
  Single {
    needle: String,
  },
  Inline {
    needles: Vec<String>,
    case_insensitive: bool,
  },
  Many(Box<aho_core::AhoCorasick>),
}

enum AhoBuildMode<'a> {
  Build,
  Capture(&'a mut Vec<PreparedAhoArtifact>),
  Load {
    automata: &'a [PreparedAhoArtifact],
    index: usize,
  },
}

enum RegexBuildMode<'a> {
  Build,
  Capture(&'a mut Vec<PreparedRegexArtifact>),
  Load {
    artifacts: &'a [PreparedRegexArtifact],
    index: usize,
  },
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct ArtifactMetrics {
  count: usize,
  bytes: usize,
}

impl RegexBuildMode<'_> {
  const fn position(&self) -> usize {
    match self {
      Self::Build => 0,
      Self::Capture(artifacts) => artifacts.len(),
      Self::Load { index, .. } => *index,
    }
  }

  fn artifact_metrics_since(&self, start: usize) -> ArtifactMetrics {
    match self {
      Self::Build => ArtifactMetrics::default(),
      Self::Capture(artifacts) => artifacts
        .get(start..)
        .map_or_else(ArtifactMetrics::default, artifact_metrics),
      Self::Load { artifacts, index } => artifacts
        .get(start..*index)
        .map_or_else(ArtifactMetrics::default, artifact_metrics),
    }
  }

  fn next_prepared_regex(&mut self) -> Result<&[u8]> {
    let Self::Load { artifacts, index } = self else {
      return Err(Error::BuildRegex(String::from(
        "Prepared regex artifact requested outside load mode",
      )));
    };
    let current = *index;
    let Some(artifact) = artifacts.get(current) else {
      return Err(Error::PreparedRegexArtifactMissing { index: current });
    };
    *index = current.saturating_add(1);
    Ok(&artifact.bytes)
  }

  const fn finish(&self) -> Result<()> {
    let Self::Load { artifacts, index } = self else {
      return Ok(());
    };
    if *index == artifacts.len() {
      return Ok(());
    }
    Err(Error::PreparedRegexArtifactCountMismatch {
      expected: *index,
      actual: artifacts.len(),
    })
  }
}

impl AhoBuildMode<'_> {
  const fn position(&self) -> usize {
    match self {
      Self::Build => 0,
      Self::Capture(automata) => automata.len(),
      Self::Load { index, .. } => *index,
    }
  }

  fn artifact_metrics_since(&self, start: usize) -> ArtifactMetrics {
    match self {
      Self::Build => ArtifactMetrics::default(),
      Self::Capture(automata) => automata
        .get(start..)
        .map_or_else(ArtifactMetrics::default, artifact_metrics),
      Self::Load { automata, index } => automata
        .get(start..*index)
        .map_or_else(ArtifactMetrics::default, artifact_metrics),
    }
  }

  fn prepared_aho_count(&self) -> Result<usize> {
    let Self::Load { automata, .. } = self else {
      return Err(Error::BuildLiteral(String::from(
        "Prepared Aho count requested outside load mode",
      )));
    };
    Ok(automata.len())
  }

  fn next_prepared_aho(
    &mut self,
  ) -> Result<(usize, LiteralOptions, bool, u64, &[u8])> {
    let Self::Load { automata, index } = self else {
      return Err(Error::BuildLiteral(String::from(
        "Prepared Aho artifact requested outside load mode",
      )));
    };
    let current = *index;
    let Some(artifact) = automata.get(current) else {
      return Err(Error::PreparedAhoArtifactMissing { index: current });
    };
    *index = current.saturating_add(1);
    Ok((
      current,
      artifact.options,
      artifact.identity,
      artifact.fingerprint,
      &artifact.bytes,
    ))
  }

  const fn finish(&self) -> Result<()> {
    let Self::Load { automata, index } = self else {
      return Ok(());
    };
    if *index == automata.len() {
      return Ok(());
    }
    Err(Error::PreparedAhoArtifactCountMismatch {
      expected: *index,
      actual: automata.len(),
    })
  }
}

trait PreparedArtifactBytes {
  fn byte_len(&self) -> usize;
}

impl PreparedArtifactBytes for PreparedAhoArtifact {
  fn byte_len(&self) -> usize {
    self.bytes.len()
  }
}

impl PreparedArtifactBytes for PreparedRegexArtifact {
  fn byte_len(&self) -> usize {
    self.bytes.len()
  }
}

fn artifact_metrics(
  artifacts: &[impl PreparedArtifactBytes],
) -> ArtifactMetrics {
  ArtifactMetrics {
    count: artifacts.len(),
    bytes: artifacts
      .iter()
      .map(PreparedArtifactBytes::byte_len)
      .fold(0usize, usize::saturating_add),
  }
}

fn push_timed_engine(
  engines: &mut Vec<EngineSlot>,
  stats: Option<&mut Vec<BuildStats>>,
  pattern_count: usize,
  pattern_bounds: PatternBounds,
  aho_mode: &mut AhoBuildMode<'_>,
  regex_mode: &mut RegexBuildMode<'_>,
  build: impl FnOnce(
    &mut AhoBuildMode<'_>,
    &mut RegexBuildMode<'_>,
  ) -> Result<EngineSlot>,
) -> Result<()> {
  let slot = engines.len();
  let aho_start = aho_mode.position();
  let regex_start = regex_mode.position();
  let start = stats.as_ref().map(|_| Instant::now());
  let engine = build(aho_mode, regex_mode)?;
  if let (Some(stats), Some(start)) = (stats, start) {
    stats.push(build_stats_for_engine(
      slot,
      &engine,
      pattern_count,
      pattern_bounds,
      elapsed_us(start),
      aho_mode.artifact_metrics_since(aho_start),
      regex_mode.artifact_metrics_since(regex_start),
    ));
  }
  engines.push(engine);
  Ok(())
}

const fn build_stats_for_engine(
  slot: usize,
  engine: &EngineSlot,
  pattern_count: usize,
  pattern_bounds: PatternBounds,
  elapsed_us: u64,
  aho_metrics: ArtifactMetrics,
  regex_metrics: ArtifactMetrics,
) -> BuildStats {
  BuildStats {
    slot,
    engine: engine_kind(engine),
    pattern_count,
    first_pattern: pattern_bounds.first,
    last_pattern: pattern_bounds.last,
    elapsed_us,
    aho_artifact_count: aho_metrics.count,
    aho_artifact_bytes: aho_metrics.bytes,
    regex_artifact_count: regex_metrics.count,
    regex_artifact_bytes: regex_metrics.bytes,
    regex_lazy: engine_regex_lazy(engine),
    regex_prefilter: engine_regex_prefilter(engine),
    regex_prefilter_regex: engine_regex_prefilter_regex(engine),
  }
}

const fn engine_kind(engine: &EngineSlot) -> EngineKind {
  match engine {
    EngineSlot::Literal(_) => EngineKind::Literal,
    EngineSlot::SplitLiteral(_) => EngineKind::SplitLiteral,
    EngineSlot::Regex(_) => EngineKind::Regex,
    EngineSlot::Fuzzy(_) => EngineKind::Fuzzy,
  }
}

const fn engine_regex_lazy(engine: &EngineSlot) -> bool {
  matches!(
    engine,
    EngineSlot::Regex(RegexSlot {
      engine: RegexEngine::Lazy { .. },
      ..
    })
  )
}

const fn engine_regex_prefilter(engine: &EngineSlot) -> bool {
  matches!(
    engine,
    EngineSlot::Regex(RegexSlot {
      prefilter: Some(_),
      ..
    })
  )
}

const fn engine_regex_prefilter_regex(engine: &EngineSlot) -> bool {
  matches!(
    engine,
    EngineSlot::Regex(RegexSlot {
      prefilter_regex: Some(_),
      ..
    })
  )
}

fn elapsed_us(start: Instant) -> u64 {
  let micros = start.elapsed().as_micros();
  u64::try_from(micros).unwrap_or(u64::MAX)
}

impl TextSearch {
  pub fn new(
    patterns: impl IntoIterator<Item = PatternEntry>,
    options: TextSearchOptions,
  ) -> Result<Self> {
    let mut aho_mode = AhoBuildMode::Build;
    let mut regex_mode = RegexBuildMode::Build;
    Self::build_with_modes(patterns, options, &mut aho_mode, &mut regex_mode)
  }

  pub fn new_with_build_stats(
    patterns: impl IntoIterator<Item = PatternEntry>,
    options: TextSearchOptions,
  ) -> Result<TextSearchBuildResult> {
    let mut aho_mode = AhoBuildMode::Build;
    let mut regex_mode = RegexBuildMode::Build;
    Self::build_with_modes_stats(
      patterns,
      options,
      &mut aho_mode,
      &mut regex_mode,
    )
  }

  pub fn prepare_artifacts(
    patterns: impl IntoIterator<Item = PatternEntry>,
    options: TextSearchOptions,
  ) -> Result<PreparedTextSearchArtifacts> {
    let mut aho_automata = Vec::new();
    let mut regex_sets = Vec::new();
    let mut aho_mode = AhoBuildMode::Capture(&mut aho_automata);
    let mut regex_mode = RegexBuildMode::Capture(&mut regex_sets);
    _ = Self::build_with_modes(
      patterns,
      options,
      &mut aho_mode,
      &mut regex_mode,
    )?;
    Ok(PreparedTextSearchArtifacts {
      aho_automata,
      regex_sets,
    })
  }

  pub fn with_prepared_artifacts(
    patterns: impl IntoIterator<Item = PatternEntry>,
    options: TextSearchOptions,
    artifacts: &PreparedTextSearchArtifacts,
  ) -> Result<Self> {
    let mut aho_mode = AhoBuildMode::Load {
      automata: &artifacts.aho_automata,
      index: 0,
    };
    let mut regex_mode = RegexBuildMode::Load {
      artifacts: &artifacts.regex_sets,
      index: 0,
    };
    let search = Self::build_with_modes(
      patterns,
      options,
      &mut aho_mode,
      &mut regex_mode,
    )?;
    aho_mode.finish()?;
    regex_mode.finish()?;
    Ok(search)
  }

  pub fn with_prepared_artifacts_build_stats(
    patterns: impl IntoIterator<Item = PatternEntry>,
    options: TextSearchOptions,
    artifacts: &PreparedTextSearchArtifacts,
  ) -> Result<TextSearchBuildResult> {
    let mut aho_mode = AhoBuildMode::Load {
      automata: &artifacts.aho_automata,
      index: 0,
    };
    let mut regex_mode = RegexBuildMode::Load {
      artifacts: &artifacts.regex_sets,
      index: 0,
    };
    let result = Self::build_with_modes_stats(
      patterns,
      options,
      &mut aho_mode,
      &mut regex_mode,
    )?;
    aho_mode.finish()?;
    regex_mode.finish()?;
    Ok(result)
  }

  pub fn with_prepared_all_literal_artifacts(
    options: TextSearchOptions,
    artifacts: &PreparedTextSearchArtifacts,
  ) -> Result<Self> {
    let mut aho_mode = AhoBuildMode::Load {
      automata: &artifacts.aho_automata,
      index: 0,
    };
    let regex_mode = RegexBuildMode::Load {
      artifacts: &artifacts.regex_sets,
      index: 0,
    };
    let search =
      Self::build_all_literal_from_aho_artifacts(options, &mut aho_mode)?;
    aho_mode.finish()?;
    regex_mode.finish()?;
    Ok(search)
  }

  pub fn with_prepared_all_literal_artifacts_build_stats(
    options: TextSearchOptions,
    artifacts: &PreparedTextSearchArtifacts,
  ) -> Result<TextSearchBuildResult> {
    let mut aho_mode = AhoBuildMode::Load {
      automata: &artifacts.aho_automata,
      index: 0,
    };
    let regex_mode = RegexBuildMode::Load {
      artifacts: &artifacts.regex_sets,
      index: 0,
    };
    let start = Instant::now();
    let search =
      Self::build_all_literal_from_aho_artifacts(options, &mut aho_mode)?;
    let stats = search
      .engines
      .first()
      .map(|engine| {
        let artifact_metrics = aho_mode.artifact_metrics_since(0);
        build_stats_for_engine(
          0,
          engine,
          search.pattern_count,
          identity_pattern_bounds(search.pattern_count),
          elapsed_us(start),
          artifact_metrics,
          ArtifactMetrics::default(),
        )
      })
      .into_iter()
      .collect();
    aho_mode.finish()?;
    regex_mode.finish()?;
    Ok(TextSearchBuildResult { search, stats })
  }

  fn build_all_literal_from_aho_artifacts(
    options: TextSearchOptions,
    aho_mode: &mut AhoBuildMode<'_>,
  ) -> Result<Self> {
    let automata_count = aho_mode.prepared_aho_count()?;
    if automata_count == 0 {
      return Ok(Self {
        engines: Vec::new(),
        pattern_count: 0,
        overlap_strategy: options.overlap_strategy,
      });
    }

    let (engine, pattern_count) = if options.whole_words
      && options.unicode_boundaries
      && automata_count > 1
    {
      let (slot, pattern_count) =
        load_split_literal_engines(options, automata_count, aho_mode)?;
      (EngineSlot::SplitLiteral(slot), pattern_count)
    } else {
      let (slot, pattern_count) =
        load_identity_literal_engine(options, aho_mode)?;
      if options.whole_words
        && options.unicode_boundaries
        && pattern_count >= SPLIT_IDENTITY_AC_MIN_PATTERNS
      {
        let LiteralSlot { engine, .. } = slot;
        (
          EngineSlot::SplitLiteral(SplitLiteralSlot {
            engines: vec![SplitLiteralEngine {
              engine,
              pattern_offset: 0,
            }],
            overlap_strategy: options.overlap_strategy,
          }),
          pattern_count,
        )
      } else {
        (EngineSlot::Literal(slot), pattern_count)
      }
    };

    Ok(Self {
      engines: vec![engine],
      pattern_count,
      overlap_strategy: options.overlap_strategy,
    })
  }

  fn build_with_modes(
    patterns: impl IntoIterator<Item = PatternEntry>,
    options: TextSearchOptions,
    aho_mode: &mut AhoBuildMode<'_>,
    regex_mode: &mut RegexBuildMode<'_>,
  ) -> Result<Self> {
    Ok(
      Self::build_with_modes_inner(
        patterns, options, aho_mode, regex_mode, None,
      )?
      .search,
    )
  }

  fn build_with_modes_stats(
    patterns: impl IntoIterator<Item = PatternEntry>,
    options: TextSearchOptions,
    aho_mode: &mut AhoBuildMode<'_>,
    regex_mode: &mut RegexBuildMode<'_>,
  ) -> Result<TextSearchBuildResult> {
    let mut stats = Vec::new();
    Self::build_with_modes_inner(
      patterns,
      options,
      aho_mode,
      regex_mode,
      Some(&mut stats),
    )
  }

  fn build_with_modes_inner(
    patterns: impl IntoIterator<Item = PatternEntry>,
    options: TextSearchOptions,
    aho_mode: &mut AhoBuildMode<'_>,
    regex_mode: &mut RegexBuildMode<'_>,
    mut stats: Option<&mut Vec<BuildStats>>,
  ) -> Result<TextSearchBuildResult> {
    let patterns = patterns.into_iter().collect::<Vec<_>>();
    let total_pattern_count = patterns.len();
    let mut engines = Vec::new();

    if options.all_literal
      && all_auto_patterns(&patterns)
      && !patterns.is_empty()
    {
      push_timed_engine(
        &mut engines,
        stats.as_deref_mut(),
        total_pattern_count,
        identity_pattern_bounds(total_pattern_count),
        aho_mode,
        regex_mode,
        |aho_mode, _| {
          build_identity_literal_engine(patterns, options, aho_mode)
        },
      )?;
      return Ok(TextSearchBuildResult {
        search: Self {
          engines,
          pattern_count: total_pattern_count,
          overlap_strategy: options.overlap_strategy,
        },
        stats: stats.map_or_else(Vec::new, std::mem::take),
      });
    }

    let parts = partition_classified_patterns(
      classify_pattern_entries(patterns, options.all_literal)?,
      options,
    );
    push_fuzzy_engines(
      &mut engines,
      &mut stats,
      parts.fuzzy,
      options,
      aho_mode,
      regex_mode,
    )?;
    push_literal_engines(
      &mut engines,
      &mut stats,
      parts.literals,
      options,
      aho_mode,
      regex_mode,
    )?;
    push_shared_regex_engines(
      &mut engines,
      &mut stats,
      parts.shared_regex,
      options,
      aho_mode,
      regex_mode,
    )?;
    push_isolated_regex_engines(
      &mut engines,
      &mut stats,
      parts.isolated_regex,
      options,
      aho_mode,
      regex_mode,
    )?;

    Ok(TextSearchBuildResult {
      search: Self {
        engines,
        pattern_count: total_pattern_count,
        overlap_strategy: options.overlap_strategy,
      },
      stats: stats.map_or_else(Vec::new, std::mem::take),
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

  pub fn warm_lazy_regex(&self) -> Result<()> {
    let lazy_engines = self
      .engines
      .iter()
      .filter(|engine| engine_has_uninitialized_lazy_regex(engine))
      .collect::<Vec<_>>();
    let lazy_count = lazy_engines.len();
    if lazy_count < PARALLEL_LAZY_REGEX_WARM_MIN_SLOTS {
      return warm_engine_refs_lazy_regex(&lazy_engines);
    }

    let workers = std::thread::available_parallelism()
      .map_or(1, usize::from)
      .min(lazy_count);
    if workers <= 1 {
      return warm_engine_refs_lazy_regex(&lazy_engines);
    }

    let chunk_size = lazy_count.div_ceil(workers);
    std::thread::scope(|scope| {
      let mut handles = Vec::with_capacity(workers);
      for chunk in lazy_engines.chunks(chunk_size) {
        handles.push(scope.spawn(move || warm_engine_refs_lazy_regex(chunk)));
      }
      for handle in handles {
        handle.join().map_err(|_| {
          Error::BuildRegex(String::from("Lazy regex warm-up panicked"))
        })??;
      }
      Ok(())
    })
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
    let mut matches = find_iter_engines(&self.engines, haystack)?;
    finalize_find_matches(&mut matches, self.overlap_strategy);
    Ok(matches)
  }

  pub fn find_iter_with_stats(
    &self,
    haystack: &str,
  ) -> Result<TextSearchFindResult> {
    let mut result = find_iter_engines_with_stats(&self.engines, haystack)?;
    finalize_find_matches(&mut result.matches, self.overlap_strategy);
    Ok(result)
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

struct ClassifiedParts {
  fuzzy: Vec<ClassifiedPattern>,
  literals: Vec<ClassifiedPattern>,
  shared_regex: Vec<ClassifiedPattern>,
  isolated_regex: Vec<ClassifiedPattern>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct PatternBounds {
  first: Option<u32>,
  last: Option<u32>,
}

fn pattern_bounds(patterns: &[ClassifiedPattern]) -> PatternBounds {
  PatternBounds {
    first: patterns.first().map(|pattern| pattern.original_index),
    last: patterns.last().map(|pattern| pattern.original_index),
  }
}

fn identity_pattern_bounds(pattern_count: usize) -> PatternBounds {
  let last = pattern_count
    .checked_sub(1)
    .and_then(|index| u32::try_from(index).ok());
  PatternBounds {
    first: last.map(|_| 0),
    last,
  }
}

fn partition_classified_patterns(
  classified: Vec<ClassifiedPattern>,
  options: TextSearchOptions,
) -> ClassifiedParts {
  let mut fuzzy = Vec::new();
  let mut literals = Vec::new();
  let mut shared_regex = Vec::new();
  let mut isolated_regex = Vec::new();

  for pattern in classified {
    if pattern.fuzzy_distance.is_some() {
      fuzzy.push(pattern);
    } else if pattern.is_literal {
      literals.push(pattern);
    } else if pattern.regex_options.as_ref().is_some_and(|regex_options| {
      regex_options.lazy
        || regex_options.prepared_artifact_policy
          != PreparedArtifactPolicy::Inherit
    }) || pattern.alternation_count > options.max_alternations
    {
      isolated_regex.push(pattern);
    } else {
      shared_regex.push(pattern);
    }
  }

  ClassifiedParts {
    fuzzy,
    literals,
    shared_regex,
    isolated_regex,
  }
}

fn push_fuzzy_engines(
  engines: &mut Vec<EngineSlot>,
  stats: &mut Option<&mut Vec<BuildStats>>,
  fuzzy: Vec<ClassifiedPattern>,
  options: TextSearchOptions,
  aho_mode: &mut AhoBuildMode<'_>,
  regex_mode: &mut RegexBuildMode<'_>,
) -> Result<()> {
  if fuzzy.is_empty() {
    return Ok(());
  }
  let fuzzy_pattern_count = fuzzy.len();
  push_timed_engine(
    engines,
    stats.as_deref_mut(),
    fuzzy_pattern_count,
    pattern_bounds(&fuzzy),
    aho_mode,
    regex_mode,
    |_, _| Ok(EngineSlot::Fuzzy(build_fuzzy_engine(fuzzy, options)?)),
  )
}

fn push_literal_engines(
  engines: &mut Vec<EngineSlot>,
  stats: &mut Option<&mut Vec<BuildStats>>,
  literals: Vec<ClassifiedPattern>,
  options: TextSearchOptions,
  aho_mode: &mut AhoBuildMode<'_>,
  regex_mode: &mut RegexBuildMode<'_>,
) -> Result<()> {
  for (literal_options, group) in group_literals(literals, options) {
    let literal_pattern_count = group.len();
    push_timed_engine(
      engines,
      stats.as_deref_mut(),
      literal_pattern_count,
      pattern_bounds(&group),
      aho_mode,
      regex_mode,
      |aho_mode, _| {
        Ok(EngineSlot::Literal(build_literal_engine(
          group,
          literal_options,
          options.overlap_strategy,
          aho_mode,
        )?))
      },
    )?;
  }
  Ok(())
}

fn push_shared_regex_engines(
  engines: &mut Vec<EngineSlot>,
  stats: &mut Option<&mut Vec<BuildStats>>,
  shared_regex: Vec<ClassifiedPattern>,
  options: TextSearchOptions,
  aho_mode: &mut AhoBuildMode<'_>,
  regex_mode: &mut RegexBuildMode<'_>,
) -> Result<()> {
  if options.overlap_strategy == OverlapStrategy::All {
    return push_overlap_all_regex_engines(
      engines,
      stats,
      shared_regex,
      options,
      aho_mode,
      regex_mode,
    );
  }

  for chunk in
    chunk_shared_regex_patterns(shared_regex, options.regex_chunk_size)
  {
    let regex_pattern_count = chunk.len();
    push_timed_engine(
      engines,
      stats.as_deref_mut(),
      regex_pattern_count,
      pattern_bounds(&chunk),
      aho_mode,
      regex_mode,
      |aho_mode, regex_mode| {
        Ok(EngineSlot::Regex(build_regex_engine(
          chunk, options, None, aho_mode, regex_mode,
        )?))
      },
    )?;
  }
  Ok(())
}

fn push_overlap_all_regex_engines(
  engines: &mut Vec<EngineSlot>,
  stats: &mut Option<&mut Vec<BuildStats>>,
  patterns: Vec<ClassifiedPattern>,
  options: TextSearchOptions,
  aho_mode: &mut AhoBuildMode<'_>,
  regex_mode: &mut RegexBuildMode<'_>,
) -> Result<()> {
  for pattern in patterns {
    let regex_options = Some(pattern.regex_options.clone().unwrap_or_default());
    push_timed_engine(
      engines,
      stats.as_deref_mut(),
      1,
      pattern_bounds(std::slice::from_ref(&pattern)),
      aho_mode,
      regex_mode,
      |aho_mode, regex_mode| {
        Ok(EngineSlot::Regex(build_regex_engine(
          vec![pattern],
          options,
          regex_options,
          aho_mode,
          regex_mode,
        )?))
      },
    )?;
  }
  Ok(())
}

fn push_isolated_regex_engines(
  engines: &mut Vec<EngineSlot>,
  stats: &mut Option<&mut Vec<BuildStats>>,
  isolated_regex: Vec<ClassifiedPattern>,
  options: TextSearchOptions,
  aho_mode: &mut AhoBuildMode<'_>,
  regex_mode: &mut RegexBuildMode<'_>,
) -> Result<()> {
  for pattern in isolated_regex {
    // Mirrors the TS lazyOptions path: `Some(..)` marks isolated regexes and
    // suppresses shared leading-literal inference.
    let lazy_options = Some(pattern.regex_options.clone().unwrap_or_default());
    push_timed_engine(
      engines,
      stats.as_deref_mut(),
      1,
      pattern_bounds(std::slice::from_ref(&pattern)),
      aho_mode,
      regex_mode,
      |aho_mode, regex_mode| {
        Ok(EngineSlot::Regex(build_regex_engine(
          vec![pattern],
          options,
          lazy_options,
          aho_mode,
          regex_mode,
        )?))
      },
    )?;
  }
  Ok(())
}

fn warm_engine_lazy_regex(engine: &EngineSlot) -> Result<()> {
  if let EngineSlot::Regex(slot) = engine {
    _ = regex_slot_engine(slot)?;
  }
  Ok(())
}

fn warm_engine_refs_lazy_regex(engines: &[&EngineSlot]) -> Result<()> {
  for engine in engines {
    warm_engine_lazy_regex(engine)?;
  }
  Ok(())
}

fn engine_has_uninitialized_lazy_regex(engine: &EngineSlot) -> bool {
  matches!(
    engine,
    EngineSlot::Regex(RegexSlot {
      engine: RegexEngine::Lazy { cell, .. },
      ..
    }) if cell.get().is_none()
  )
}

pub fn classify_patterns(
  entries: &[PatternEntry],
  all_literal: bool,
) -> Result<Vec<ClassifiedPattern>> {
  classify_pattern_entries(entries.to_vec(), all_literal)
}

fn classify_pattern_entries(
  entries: Vec<PatternEntry>,
  all_literal: bool,
) -> Result<Vec<ClassifiedPattern>> {
  let mut result = Vec::with_capacity(entries.len());
  for (index, entry) in entries.into_iter().enumerate() {
    let original_index = pattern_index(index)?;
    result.push(match entry {
      PatternEntry::Auto(pattern) => {
        let alternation_count = if all_literal {
          0
        } else {
          count_alternations(&pattern)
        };
        let is_literal = all_literal || is_literal_pattern(&pattern);
        let regex_complexity =
          score_regex_complexity(&pattern, alternation_count);
        ClassifiedPattern {
          original_index,
          pattern,
          name: None,
          alternation_count,
          is_literal,
          fuzzy_distance: None,
          ac_options: None,
          regex_options: None,
          regex_complexity,
        }
      }
      PatternEntry::Regex(regex_pattern) => {
        let RegexPattern {
          pattern: source,
          name,
          lazy,
          prefilter_any,
          prefilter_case_insensitive,
          prefilter_regex,
          prefilter_window_bytes,
          prepared_artifact_policy,
        } = regex_pattern;
        let alternation_count = count_alternations(&source);
        let regex_complexity =
          score_regex_complexity(&source, alternation_count);
        ClassifiedPattern {
          original_index,
          pattern: source,
          name,
          alternation_count,
          is_literal: false,
          fuzzy_distance: None,
          ac_options: None,
          regex_options: Some(RegexOptions {
            lazy,
            prefilter_any,
            prefilter_case_insensitive,
            prefilter_regex,
            prefilter_window_bytes,
            prepared_artifact_policy,
          }),
          regex_complexity,
        }
      }
      PatternEntry::Literal(pattern) => ClassifiedPattern {
        original_index,
        pattern: pattern.pattern,
        name: pattern.name,
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
        pattern: pattern.pattern,
        name: pattern.name,
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
      unicode_boundaries: options.unicode_boundaries,
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
  patterns: Vec<PatternEntry>,
  options: TextSearchOptions,
  aho_mode: &mut AhoBuildMode<'_>,
) -> Result<EngineSlot> {
  let pattern_count = patterns.len();

  if options.whole_words
    && options.unicode_boundaries
    && pattern_count >= SPLIT_IDENTITY_AC_MIN_PATTERNS
  {
    let mut engines =
      Vec::with_capacity(pattern_count.div_ceil(SPLIT_IDENTITY_AC_CHUNK_SIZE));
    let mut offset = 0_usize;
    let mut values =
      Vec::with_capacity(pattern_count.min(SPLIT_IDENTITY_AC_CHUNK_SIZE));
    for pattern in patterns {
      let PatternEntry::Auto(value) = pattern else {
        return Err(Error::BuildLiteral(String::from(
          "Identity literal engine received a non-literal pattern",
        )));
      };
      values.push(value);
      if values.len() == SPLIT_IDENTITY_AC_CHUNK_SIZE {
        push_split_literal_engine(
          &mut engines,
          values,
          offset,
          options,
          aho_mode,
        )?;
        offset = offset
          .checked_add(SPLIT_IDENTITY_AC_CHUNK_SIZE)
          .ok_or(Error::PatternIndexOutOfRange { index: usize::MAX })?;
        values = Vec::with_capacity(
          pattern_count
            .saturating_sub(offset)
            .min(SPLIT_IDENTITY_AC_CHUNK_SIZE),
        );
      }
    }
    if !values.is_empty() {
      push_split_literal_engine(
        &mut engines,
        values,
        offset,
        options,
        aho_mode,
      )?;
    }

    return Ok(EngineSlot::SplitLiteral(SplitLiteralSlot {
      engines,
      overlap_strategy: options.overlap_strategy,
    }));
  }

  let mut pattern_strings = Vec::with_capacity(pattern_count);
  for pattern in patterns {
    let PatternEntry::Auto(value) = pattern else {
      return Err(Error::BuildLiteral(String::from(
        "Identity literal engine received a non-literal pattern",
      )));
    };
    pattern_strings.push(value);
  }

  Ok(EngineSlot::Literal(LiteralSlot {
    engine: build_aho(pattern_strings, options.into(), true, aho_mode)?,
    index_map: Vec::new(),
    name_map: Vec::new(),
    identity_map: true,
    overlap_strategy: options.overlap_strategy,
  }))
}

fn push_split_literal_engine(
  engines: &mut Vec<SplitLiteralEngine>,
  patterns: Vec<String>,
  offset: usize,
  options: TextSearchOptions,
  aho_mode: &mut AhoBuildMode<'_>,
) -> Result<()> {
  engines.push(SplitLiteralEngine {
    engine: build_aho(patterns, options.into(), true, aho_mode)?,
    pattern_offset: pattern_index(offset)?,
  });
  Ok(())
}

fn load_split_literal_engines(
  options: TextSearchOptions,
  automata_count: usize,
  aho_mode: &mut AhoBuildMode<'_>,
) -> Result<(SplitLiteralSlot, usize)> {
  let expected_options = options.into();
  let mut engines = Vec::with_capacity(automata_count);
  let mut offset = 0usize;
  for _ in 0..automata_count {
    let (artifact, actual_options, actual_identity, _, engine, count) =
      load_prepared_aho_any(aho_mode)?;
    validate_prepared_aho_options(artifact, actual_options, expected_options)?;
    validate_prepared_aho_identity(artifact, actual_identity, true)?;
    engines.push(SplitLiteralEngine {
      engine,
      pattern_offset: pattern_index(offset)?,
    });
    let count = usize::try_from(count)
      .map_err(|_| Error::PatternIndexOutOfRange { index: usize::MAX })?;
    offset = offset
      .checked_add(count)
      .ok_or(Error::PatternIndexOutOfRange { index: usize::MAX })?;
  }

  Ok((
    SplitLiteralSlot {
      engines,
      overlap_strategy: options.overlap_strategy,
    },
    offset,
  ))
}

fn load_identity_literal_engine(
  options: TextSearchOptions,
  aho_mode: &mut AhoBuildMode<'_>,
) -> Result<(LiteralSlot, usize)> {
  let expected_options = options.into();
  let (artifact, actual_options, actual_identity, _, engine, pattern_count) =
    load_prepared_aho_any(aho_mode)?;
  validate_prepared_aho_options(artifact, actual_options, expected_options)?;
  validate_prepared_aho_identity(artifact, actual_identity, true)?;
  let pattern_count = usize::try_from(pattern_count)
    .map_err(|_| Error::PatternIndexOutOfRange { index: usize::MAX })?;
  Ok((
    LiteralSlot {
      engine,
      index_map: Vec::new(),
      name_map: Vec::new(),
      identity_map: true,
      overlap_strategy: options.overlap_strategy,
    },
    pattern_count,
  ))
}

fn build_literal_engine(
  patterns: Vec<ClassifiedPattern>,
  options: LiteralOptions,
  overlap_strategy: OverlapStrategy,
  aho_mode: &mut AhoBuildMode<'_>,
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
    engine: build_aho(values, options, false, aho_mode)?,
    index_map,
    name_map,
    identity_map: false,
    overlap_strategy,
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
  aho_mode: &mut AhoBuildMode<'_>,
  regex_mode: &mut RegexBuildMode<'_>,
) -> Result<RegexSlot> {
  let inferred_prefilter = if lazy_options.is_none() && patterns.len() == 1 {
    patterns
      .first()
      .and_then(|pattern| infer_leading_literal_prefilter(&pattern.pattern))
      .map(|prefilter| {
        build_literal_prefilter(
          &[prefilter.literal],
          prefilter.case_insensitive || options.case_insensitive,
          aho_mode,
          false,
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
  let prefilter_window_bytes =
    lazy_options.as_ref().and_then(|regex_options| {
      regex_options
        .lazy
        .then_some(regex_options.prefilter_window_bytes)
        .flatten()
    });
  let prefilter_window_needs_full_context = prefilter_window_bytes.is_some()
    && values.iter().any(|pattern| has_lookaround(pattern));

  let (engine, prefilter, prefilter_regex) = match lazy_options {
    Some(lazy_options) if lazy_options.lazy => {
      let windowed = lazy_options.prefilter_window_bytes.is_some();
      let prefilter = if lazy_options.prefilter_any.is_empty() {
        None
      } else {
        Some(build_literal_prefilter(
          &lazy_options.prefilter_any,
          lazy_options
            .prefilter_case_insensitive
            .unwrap_or(options.case_insensitive),
          aho_mode,
          windowed,
        )?)
      };
      let prefilter_regex = lazy_options
        .prefilter_regex
        .map(|source| build_prefilter_regex(source, regex_mode))
        .transpose()?
        .map(Box::new);
      let capture_prepared = lazy_options
        .prepared_artifact_policy
        .should_capture(options.regex_artifact_policy);
      let prepared = capture_or_load_lazy_regex(
        &values,
        engine_options,
        regex_mode,
        capture_prepared,
      )?;
      let engine = RegexEngine::Lazy {
        patterns: values,
        options: engine_options,
        prepared,
        cell: OnceLock::new(),
      };
      (engine, prefilter, prefilter_regex)
    }
    _ => {
      let capture_prepared = should_capture_eager_regex_artifact(
        lazy_options.as_ref(),
        options.regex_artifact_policy,
      );
      let engine = RegexEngine::Eager(Box::new(build_regex_set(
        values,
        engine_options,
        regex_mode,
        capture_prepared,
      )?));
      (engine, inferred_prefilter, None)
    }
  };

  Ok(RegexSlot {
    engine,
    prefilter,
    prefilter_regex,
    prefilter_window_bytes,
    prefilter_window_needs_full_context,
    index_map,
    name_map,
  })
}

fn should_capture_eager_regex_artifact(
  regex_options: Option<&RegexOptions>,
  default_policy: RegexArtifactPolicy,
) -> bool {
  regex_options.map_or(
    matches!(default_policy, RegexArtifactPolicy::Include),
    |options| {
      options
        .prepared_artifact_policy
        .should_capture(default_policy)
    },
  )
}

fn regex_slot_engine(slot: &RegexSlot) -> Result<&regex_core::RegexSet> {
  match &slot.engine {
    RegexEngine::Eager(engine) => Ok(engine.as_ref()),
    RegexEngine::Lazy {
      patterns,
      options,
      prepared,
      cell,
    } => {
      if let Some(engine) = cell.get() {
        return Ok(engine.as_ref());
      }

      let engine = prepared
        .as_deref()
        .map_or_else(
          || regex_core::RegexSet::new(patterns.clone(), *options),
          |bytes| {
            regex_core::RegexSet::with_prepared(
              patterns.clone(),
              *options,
              bytes,
            )
          },
        )
        .map_err(|error| Error::BuildRegex(error.to_string()))?;
      _ = cell.set(Box::new(engine));
      cell.get().map(Box::as_ref).ok_or_else(|| {
        Error::BuildRegex(String::from("Lazy regex engine was not initialized"))
      })
    }
  }
}

fn build_regex_set(
  patterns: Vec<String>,
  options: regex_core::Options,
  regex_mode: &mut RegexBuildMode<'_>,
  capture_prepared: bool,
) -> Result<regex_core::RegexSet> {
  match regex_mode {
    RegexBuildMode::Build => regex_core::RegexSet::new(patterns, options),
    RegexBuildMode::Capture(artifacts) => {
      if !capture_prepared {
        artifacts.push(PreparedRegexArtifact { bytes: Vec::new() });
        return regex_core::RegexSet::new(patterns, options)
          .map_err(|error| Error::BuildRegex(error.to_string()));
      }
      let bytes = regex_core::RegexSet::prepare(patterns.clone(), options)
        .map_err(|error| Error::BuildRegex(error.to_string()))?;
      let set = regex_core::RegexSet::with_prepared(patterns, options, &bytes);
      artifacts.push(PreparedRegexArtifact { bytes });
      set
    }
    RegexBuildMode::Load { .. } => {
      let bytes = regex_mode.next_prepared_regex()?;
      if bytes.is_empty() {
        return regex_core::RegexSet::new(patterns, options)
          .map_err(|error| Error::BuildRegex(error.to_string()));
      }
      regex_core::RegexSet::with_prepared(patterns, options, bytes)
    }
  }
  .map_err(|error| Error::BuildRegex(error.to_string()))
}

fn capture_or_load_lazy_regex(
  patterns: &[String],
  options: regex_core::Options,
  regex_mode: &mut RegexBuildMode<'_>,
  capture_prepared: bool,
) -> Result<Option<Vec<u8>>> {
  match regex_mode {
    RegexBuildMode::Build => Ok(None),
    RegexBuildMode::Capture(artifacts) => {
      if !capture_prepared {
        artifacts.push(PreparedRegexArtifact { bytes: Vec::new() });
        return Ok(None);
      }
      let bytes = regex_core::RegexSet::prepare(patterns.to_vec(), options)
        .map_err(|error| Error::BuildRegex(error.to_string()))?;
      artifacts.push(PreparedRegexArtifact {
        bytes: bytes.clone(),
      });
      Ok(Some(bytes))
    }
    RegexBuildMode::Load { .. } => {
      let bytes = regex_mode.next_prepared_regex()?;
      if bytes.is_empty() {
        return Ok(None);
      }
      Ok(Some(bytes.to_vec()))
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
  aho_mode: &mut AhoBuildMode<'_>,
  force_engine: bool,
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
  if unique.len() == 1 && !case_insensitive && !force_engine {
    let needle = unique.pop().unwrap_or_default();
    return Ok(LiteralPrefilter::Single { needle });
  }

  if should_inline_literal_prefilter(&unique) && !force_engine {
    return Ok(LiteralPrefilter::Inline {
      needles: unique,
      case_insensitive,
    });
  }

  build_aho(
    unique,
    LiteralOptions {
      case_insensitive,
      whole_words: false,
      unicode_boundaries: true,
    },
    false,
    aho_mode,
  )
  .map(Box::new)
  .map(LiteralPrefilter::Many)
}

fn should_inline_literal_prefilter(literals: &[String]) -> bool {
  if literals.is_empty()
    || literals.len() > INLINE_LITERAL_PREFILTER_MAX_PATTERNS
  {
    return false;
  }
  let byte_len = literals
    .iter()
    .map(String::len)
    .try_fold(0usize, usize::checked_add);
  byte_len.is_some_and(|len| len <= INLINE_LITERAL_PREFILTER_MAX_BYTES)
}

fn inline_literal_prefilter_matches(
  haystack: &str,
  needle: &str,
  case_insensitive: bool,
) -> bool {
  if haystack.contains(needle) {
    return true;
  }
  if !case_insensitive {
    return false;
  }
  if needle.is_ascii() {
    if contains_ignore_ascii_case(haystack.as_bytes(), needle.as_bytes()) {
      return true;
    }
    if haystack.is_ascii() {
      return false;
    }
  }
  contains_unicode_case_insensitive(haystack, needle)
}

fn contains_ignore_ascii_case(haystack: &[u8], needle: &[u8]) -> bool {
  if needle.is_empty() {
    return true;
  }
  haystack
    .windows(needle.len())
    .any(|candidate| candidate.eq_ignore_ascii_case(needle))
}

fn contains_unicode_case_insensitive(haystack: &str, needle: &str) -> bool {
  if needle.is_empty() {
    return true;
  }

  let needle_lower = needle
    .chars()
    .flat_map(char::to_lowercase)
    .collect::<Vec<_>>();
  if contains_case_folded_chars(haystack, &needle_lower, char::to_lowercase) {
    return true;
  }

  let needle_upper = needle
    .chars()
    .flat_map(char::to_uppercase)
    .collect::<Vec<_>>();
  if needle_upper == needle_lower {
    return false;
  }
  contains_case_folded_chars(haystack, &needle_upper, char::to_uppercase)
}

fn contains_case_folded_chars<I>(
  haystack: &str,
  needle: &[char],
  fold: impl Fn(char) -> I + Copy,
) -> bool
where
  I: Iterator<Item = char>,
{
  haystack.char_indices().any(|(start, _)| {
    let Some(rest) = haystack.get(start..) else {
      return false;
    };
    let mut folded = rest.chars().flat_map(fold);
    needle
      .iter()
      .all(|needle_char| folded.next() == Some(*needle_char))
  })
}

/// Builds a secondary regex prefilter gate.
///
/// Mirrors the TS `prefilterRegex.test(haystack)` check: a bare match test with
/// no whole-word wrapping, independent of the slot's own engine options.
fn build_prefilter_regex(
  source: String,
  regex_mode: &mut RegexBuildMode<'_>,
) -> Result<regex_core::RegexSet> {
  build_regex_set(
    vec![source],
    regex_core::Options {
      whole_words: false,
      unicode_boundaries: true,
    },
    regex_mode,
    true,
  )
}

fn build_aho(
  patterns: Vec<String>,
  options: LiteralOptions,
  identity: bool,
  aho_mode: &mut AhoBuildMode<'_>,
) -> Result<aho_core::AhoCorasick> {
  let expected = u32::try_from(patterns.len()).map_err(|_| {
    Error::PatternIndexOutOfRange {
      index: patterns.len(),
    }
  })?;
  let build_options = aho_core::Options {
    match_kind: aho_core::MatchKind::LeftmostFirst,
    case_insensitive: options.case_insensitive,
    dfa: false,
    whole_words: options.whole_words,
    unicode_boundaries: options.unicode_boundaries,
  };

  match aho_mode {
    AhoBuildMode::Build => aho_core::AhoCorasick::new(patterns, build_options)
      .map_err(|error| Error::BuildLiteral(error.to_string())),
    AhoBuildMode::Capture(automata) => {
      let fingerprint = aho_fingerprint(&patterns, options)?;
      let engine = aho_core::AhoCorasick::new(patterns, build_options)
        .map_err(|error| Error::BuildLiteral(error.to_string()))?;
      let bytes = engine
        .to_prepared()
        .map_err(|error| Error::BuildLiteral(error.to_string()))?;
      automata.push(PreparedAhoArtifact {
        fingerprint,
        options,
        identity,
        bytes,
      });
      Ok(engine)
    }
    AhoBuildMode::Load { .. } => {
      let fingerprint = aho_fingerprint(&patterns, options)?;
      let expected = usize::try_from(expected)
        .map_err(|_| Error::PatternIndexOutOfRange { index: usize::MAX })?;
      load_prepared_aho(aho_mode, expected, fingerprint, identity)
    }
  }
}

fn load_prepared_aho(
  aho_mode: &mut AhoBuildMode<'_>,
  expected: usize,
  fingerprint: u64,
  identity: bool,
) -> Result<aho_core::AhoCorasick> {
  let expected = u32::try_from(expected)
    .map_err(|_| Error::PatternIndexOutOfRange { index: expected })?;
  let (artifact, _, actual_identity, actual_fingerprint, engine, actual) =
    load_prepared_aho_any(aho_mode)?;
  if actual != expected {
    return Err(Error::PreparedAhoPatternCountMismatch {
      artifact,
      expected,
      actual,
    });
  }
  if actual_fingerprint != fingerprint {
    return Err(Error::PreparedAhoFingerprintMismatch { artifact });
  }
  validate_prepared_aho_identity(artifact, actual_identity, identity)?;
  Ok(engine)
}

fn load_prepared_aho_any(
  aho_mode: &mut AhoBuildMode<'_>,
) -> Result<(usize, LiteralOptions, bool, u64, aho_core::AhoCorasick, u32)> {
  let (artifact, options, identity, fingerprint, bytes) =
    aho_mode.next_prepared_aho()?;
  let engine = aho_core::AhoCorasick::from_prepared(bytes)
    .map_err(|error| Error::BuildLiteral(error.to_string()))?;
  let actual = engine.pattern_count();
  Ok((artifact, options, identity, fingerprint, engine, actual))
}

fn validate_prepared_aho_options(
  artifact: usize,
  actual: LiteralOptions,
  expected: LiteralOptions,
) -> Result<()> {
  if actual == expected {
    return Ok(());
  }
  Err(Error::PreparedAhoOptionsMismatch { artifact })
}

const fn validate_prepared_aho_identity(
  artifact: usize,
  actual: bool,
  expected: bool,
) -> Result<()> {
  if actual == expected {
    return Ok(());
  }
  Err(Error::PreparedAhoIdentityMismatch { artifact })
}

fn aho_fingerprint(
  patterns: &[String],
  options: LiteralOptions,
) -> Result<u64> {
  let mut hash = AHO_FINGERPRINT_OFFSET;
  hash = fingerprint_byte(hash, AHO_FINGERPRINT_SCHEMA_VERSION);
  hash = fingerprint_bool(hash, options.case_insensitive);
  hash = fingerprint_bool(hash, options.whole_words);
  hash = fingerprint_bool(hash, options.unicode_boundaries);
  hash = fingerprint_usize(hash, patterns.len())?;
  for pattern in patterns {
    hash = fingerprint_usize(hash, pattern.len())?;
    hash = fingerprint_bytes(hash, pattern.as_bytes());
  }
  Ok(hash)
}

fn fingerprint_usize(hash: u64, value: usize) -> Result<u64> {
  let value = u64::try_from(value)
    .map_err(|_| Error::PatternIndexOutOfRange { index: value })?;
  Ok(fingerprint_bytes(hash, &value.to_le_bytes()))
}

fn fingerprint_bool(hash: u64, value: bool) -> u64 {
  fingerprint_byte(hash, u8::from(value))
}

fn fingerprint_bytes(mut hash: u64, bytes: &[u8]) -> u64 {
  for byte in bytes {
    hash = fingerprint_byte(hash, *byte);
  }
  hash
}

fn fingerprint_byte(hash: u64, byte: u8) -> u64 {
  (hash ^ u64::from(byte)).wrapping_mul(AHO_FINGERPRINT_PRIME)
}

const fn literal_options_to_flags(options: LiteralOptions) -> u8 {
  let mut flags = 0;
  if options.case_insensitive {
    flags |= PREPARED_LITERAL_CASE_INSENSITIVE;
  }
  if options.whole_words {
    flags |= PREPARED_LITERAL_WHOLE_WORDS;
  }
  if options.unicode_boundaries {
    flags |= PREPARED_LITERAL_UNICODE_BOUNDARIES;
  }
  flags
}

fn literal_options_from_flags(flags: u8) -> Result<LiteralOptions> {
  if flags & !PREPARED_LITERAL_FLAGS_MASK != 0 {
    return Err(invalid_prepared_artifact(
      "unsupported literal option flags",
    ));
  }
  Ok(LiteralOptions {
    case_insensitive: flags & PREPARED_LITERAL_CASE_INSENSITIVE != 0,
    whole_words: flags & PREPARED_LITERAL_WHOLE_WORDS != 0,
    unicode_boundaries: flags & PREPARED_LITERAL_UNICODE_BOUNDARIES != 0,
  })
}

fn read_identity_flag(value: u8) -> Result<bool> {
  match value {
    0 => Ok(false),
    1 => Ok(true),
    _ => Err(invalid_prepared_artifact(
      "unsupported identity artifact flag",
    )),
  }
}

struct PreparedArtifactReader<'a> {
  bytes: &'a [u8],
  offset: usize,
}

impl<'a> PreparedArtifactReader<'a> {
  const fn new(bytes: &'a [u8]) -> Self {
    Self { bytes, offset: 0 }
  }

  const fn remaining_len(&self) -> usize {
    self.bytes.len().saturating_sub(self.offset)
  }

  fn read_u32(&mut self) -> Result<u32> {
    let bytes = self.read_bytes(4)?;
    let array = <[u8; 4]>::try_from(bytes)
      .map_err(|_| invalid_prepared_artifact("malformed u32"))?;
    Ok(u32::from_le_bytes(array))
  }

  fn read_u8(&mut self) -> Result<u8> {
    self
      .read_bytes(1)?
      .first()
      .copied()
      .ok_or_else(|| invalid_prepared_artifact("malformed u8"))
  }

  fn read_u64(&mut self) -> Result<u64> {
    let bytes = self.read_bytes(8)?;
    let array = <[u8; 8]>::try_from(bytes)
      .map_err(|_| invalid_prepared_artifact("malformed u64"))?;
    Ok(u64::from_le_bytes(array))
  }

  fn read_usize(&mut self) -> Result<usize> {
    usize::try_from(self.read_u32()?)
      .map_err(|_| invalid_prepared_artifact("length is not addressable"))
  }

  fn read_len_prefixed_bytes(&mut self) -> Result<&'a [u8]> {
    let len = self.read_usize()?;
    self.read_bytes(len)
  }

  fn read_bytes(&mut self, len: usize) -> Result<&'a [u8]> {
    let end = self
      .offset
      .checked_add(len)
      .ok_or_else(|| invalid_prepared_artifact("length overflow"))?;
    let bytes = self
      .bytes
      .get(self.offset..end)
      .ok_or_else(|| invalid_prepared_artifact("truncated data"))?;
    self.offset = end;
    Ok(bytes)
  }

  fn finish(&self) -> Result<()> {
    if self.offset == self.bytes.len() {
      return Ok(());
    }
    Err(invalid_prepared_artifact("trailing data"))
  }
}

fn write_u32(bytes: &mut Vec<u8>, value: u32) {
  bytes.extend_from_slice(&value.to_le_bytes());
}

fn write_u8(bytes: &mut Vec<u8>, value: u8) {
  bytes.push(value);
}

fn write_u64(bytes: &mut Vec<u8>, value: u64) {
  bytes.extend_from_slice(&value.to_le_bytes());
}

fn checked_len_u32(len: usize, field: &'static str) -> Result<u32> {
  u32::try_from(len).map_err(|_| Error::PreparedArtifactTooLarge { field, len })
}

fn invalid_prepared_artifact(reason: impl Into<String>) -> Error {
  Error::PreparedArtifactInvalid {
    reason: reason.into(),
  }
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
    EngineSlot::Regex(slot) => regex_slot_is_match(slot, haystack),
    EngineSlot::Fuzzy(slot) => slot
      .engine
      .is_match(haystack)
      .map_err(|error| Error::BuildFuzzy(error.to_string())),
  }
}

fn engine_find_iter(engine: &EngineSlot, haystack: &str) -> Result<Vec<Match>> {
  match engine {
    EngineSlot::Literal(slot) => {
      let packed = if slot.overlap_strategy == OverlapStrategy::All {
        slot.engine.find_overlapping_iter_packed_bytes(haystack)
      } else {
        slot.engine.find_iter_packed_bytes(haystack)
      }
      .map_err(|error| Error::BuildLiteral(error.to_string()))?;
      extend_triple_matches(
        SearchEngine::Literal,
        haystack,
        &packed,
        &Remap::Mapped {
          index_map: &slot.index_map,
          name_map: &slot.name_map,
          identity: slot.identity_map,
        },
      )
    }
    EngineSlot::SplitLiteral(slot) => split_literal_find_iter(slot, haystack),
    EngineSlot::Regex(slot) => {
      let packed = regex_slot_find_iter_packed_bytes(slot, haystack)?;
      extend_triple_matches(
        SearchEngine::Regex,
        haystack,
        &packed,
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
        .find_iter_packed_bytes(haystack)
        .map_err(|error| Error::BuildFuzzy(error.to_string()))?,
      &slot.index_map,
      &slot.name_map,
    ),
  }
}

fn engine_find_iter_with_stats(
  engine: &EngineSlot,
  haystack: &str,
  slot: usize,
) -> Result<TextSearchFindResult> {
  if let EngineSlot::SplitLiteral(split) = engine {
    return split_literal_find_iter_with_stats(split, haystack, slot);
  }

  let start = Instant::now();
  let matches = engine_find_iter(engine, haystack)?;
  let stats = vec![find_stats_for_engine(
    slot,
    None,
    engine_kind(engine),
    engine_pattern_count(engine),
    engine_pattern_bounds(engine),
    matches.len(),
    start,
  )];
  Ok(TextSearchFindResult { matches, stats })
}

fn find_iter_engines(
  engines: &[EngineSlot],
  haystack: &str,
) -> Result<Vec<Match>> {
  if should_parallel_find(engines, haystack) {
    return find_iter_engines_parallel(engines, haystack);
  }

  find_iter_engines_sequential(engines, haystack)
}

fn find_iter_engines_with_stats(
  engines: &[EngineSlot],
  haystack: &str,
) -> Result<TextSearchFindResult> {
  if should_parallel_find(engines, haystack) {
    return find_iter_engines_parallel_with_stats(engines, haystack);
  }

  find_iter_engines_sequential_with_stats(engines, haystack, 0)
}

fn find_iter_engines_sequential(
  engines: &[EngineSlot],
  haystack: &str,
) -> Result<Vec<Match>> {
  let mut matches = Vec::new();
  for engine in engines {
    matches.extend(engine_find_iter(engine, haystack)?);
  }
  Ok(matches)
}

fn find_iter_engines_sequential_with_stats(
  engines: &[EngineSlot],
  haystack: &str,
  slot_offset: usize,
) -> Result<TextSearchFindResult> {
  let mut matches = Vec::new();
  let mut stats = Vec::new();
  for (index, engine) in engines.iter().enumerate() {
    let result = engine_find_iter_with_stats(
      engine,
      haystack,
      slot_offset.saturating_add(index),
    )?;
    matches.extend(result.matches);
    stats.extend(result.stats);
  }
  Ok(TextSearchFindResult { matches, stats })
}

fn find_iter_engines_parallel(
  engines: &[EngineSlot],
  haystack: &str,
) -> Result<Vec<Match>> {
  let workers = parallel_find_workers(engines.len());
  if workers <= 1 {
    return find_iter_engines_sequential(engines, haystack);
  }

  let chunk_size = engines.len().div_ceil(workers);
  std::thread::scope(|scope| {
    let mut handles = Vec::new();
    for chunk in engines.chunks(chunk_size) {
      handles.push(
        scope.spawn(move || find_iter_engines_sequential(chunk, haystack)),
      );
    }

    let mut matches = Vec::new();
    for handle in handles {
      let chunk_matches = handle.join().map_err(|_| {
        Error::BuildRegex(String::from("Parallel search panicked"))
      })??;
      matches.extend(chunk_matches);
    }
    Ok(matches)
  })
}

fn find_iter_engines_parallel_with_stats(
  engines: &[EngineSlot],
  haystack: &str,
) -> Result<TextSearchFindResult> {
  let workers = parallel_find_workers(engines.len());
  if workers <= 1 {
    return find_iter_engines_sequential_with_stats(engines, haystack, 0);
  }

  let chunk_size = engines.len().div_ceil(workers);
  std::thread::scope(|scope| {
    let mut handles = Vec::new();
    for (chunk_index, chunk) in engines.chunks(chunk_size).enumerate() {
      let slot_offset = chunk_index.saturating_mul(chunk_size);
      handles.push(scope.spawn(move || {
        find_iter_engines_sequential_with_stats(chunk, haystack, slot_offset)
      }));
    }

    let mut matches = Vec::new();
    let mut stats = Vec::new();
    for handle in handles {
      let result = handle.join().map_err(|_| {
        Error::BuildRegex(String::from("Parallel search panicked"))
      })??;
      matches.extend(result.matches);
      stats.extend(result.stats);
    }
    Ok(TextSearchFindResult { matches, stats })
  })
}

const fn should_parallel_find(engines: &[EngineSlot], haystack: &str) -> bool {
  haystack.len() >= PARALLEL_FIND_MIN_BYTES
    && engines.len() >= PARALLEL_FIND_MIN_ENGINES
}

fn parallel_find_workers(engine_count: usize) -> usize {
  std::thread::available_parallelism()
    .map_or(1, std::num::NonZeroUsize::get)
    .min(PARALLEL_FIND_MAX_WORKERS)
    .min(engine_count)
}

fn split_literal_find_iter(
  slot: &SplitLiteralSlot,
  haystack: &str,
) -> Result<Vec<Match>> {
  let matches = if should_parallel_split_literal_find(&slot.engines, haystack) {
    split_literal_find_iter_parallel(&slot.engines, haystack)?
  } else {
    split_literal_find_iter_sequential(&slot.engines, haystack)?
  };

  if slot.overlap_strategy == OverlapStrategy::All {
    return Ok(matches);
  }

  Ok(select_leftmost_longest_matches(matches))
}

fn split_literal_find_iter_with_stats(
  slot: &SplitLiteralSlot,
  haystack: &str,
  slot_index: usize,
) -> Result<TextSearchFindResult> {
  let mut result =
    if should_parallel_split_literal_find(&slot.engines, haystack) {
      split_literal_find_iter_parallel_with_stats(
        &slot.engines,
        haystack,
        slot_index,
      )?
    } else {
      split_literal_find_iter_sequential_with_stats(
        &slot.engines,
        haystack,
        slot_index,
        0,
      )?
    };

  if slot.overlap_strategy != OverlapStrategy::All {
    result.matches = select_leftmost_longest_matches(result.matches);
  }
  Ok(result)
}

fn split_literal_find_iter_sequential(
  engines: &[SplitLiteralEngine],
  haystack: &str,
) -> Result<Vec<Match>> {
  let mut matches = Vec::new();
  for engine in engines {
    matches.extend(split_literal_engine_find_iter(engine, haystack)?);
  }
  Ok(matches)
}

fn split_literal_find_iter_sequential_with_stats(
  engines: &[SplitLiteralEngine],
  haystack: &str,
  slot_index: usize,
  subslot_offset: usize,
) -> Result<TextSearchFindResult> {
  let mut matches = Vec::new();
  let mut stats = Vec::new();
  for (index, engine) in engines.iter().enumerate() {
    let subslot = subslot_offset.saturating_add(index);
    let start = Instant::now();
    let engine_matches = split_literal_engine_find_iter(engine, haystack)?;
    stats.push(find_stats_for_engine(
      slot_index,
      Some(subslot),
      EngineKind::SplitLiteral,
      split_literal_engine_pattern_count(engine),
      split_literal_engine_pattern_bounds(engine),
      engine_matches.len(),
      start,
    ));
    matches.extend(engine_matches);
  }
  Ok(TextSearchFindResult { matches, stats })
}

fn split_literal_find_iter_parallel(
  engines: &[SplitLiteralEngine],
  haystack: &str,
) -> Result<Vec<Match>> {
  let workers = parallel_find_workers(engines.len());
  if workers <= 1 {
    return split_literal_find_iter_sequential(engines, haystack);
  }

  let chunk_size = engines.len().div_ceil(workers);
  std::thread::scope(|scope| {
    let mut handles = Vec::with_capacity(workers);
    for chunk in engines.chunks(chunk_size) {
      handles.push(
        scope
          .spawn(move || split_literal_find_iter_sequential(chunk, haystack)),
      );
    }

    let mut matches = Vec::new();
    for handle in handles {
      let chunk_matches = handle.join().map_err(|_| {
        Error::BuildLiteral(String::from(
          "Parallel split literal search panicked",
        ))
      })??;
      matches.extend(chunk_matches);
    }
    Ok(matches)
  })
}

fn split_literal_find_iter_parallel_with_stats(
  engines: &[SplitLiteralEngine],
  haystack: &str,
  slot_index: usize,
) -> Result<TextSearchFindResult> {
  let workers = parallel_find_workers(engines.len());
  if workers <= 1 {
    return split_literal_find_iter_sequential_with_stats(
      engines, haystack, slot_index, 0,
    );
  }

  let chunk_size = engines.len().div_ceil(workers);
  std::thread::scope(|scope| {
    let mut handles = Vec::with_capacity(workers);
    for (chunk_index, chunk) in engines.chunks(chunk_size).enumerate() {
      let subslot_offset = chunk_index.saturating_mul(chunk_size);
      handles.push(scope.spawn(move || {
        split_literal_find_iter_sequential_with_stats(
          chunk,
          haystack,
          slot_index,
          subslot_offset,
        )
      }));
    }

    let mut matches = Vec::new();
    let mut stats = Vec::new();
    for handle in handles {
      let result = handle.join().map_err(|_| {
        Error::BuildLiteral(String::from(
          "Parallel split literal search panicked",
        ))
      })??;
      matches.extend(result.matches);
      stats.extend(result.stats);
    }
    Ok(TextSearchFindResult { matches, stats })
  })
}

fn split_literal_engine_find_iter(
  engine: &SplitLiteralEngine,
  haystack: &str,
) -> Result<Vec<Match>> {
  let packed = engine
    .engine
    .find_overlapping_iter_packed_bytes(haystack)
    .map_err(|error| Error::BuildLiteral(error.to_string()))?;
  extend_triple_matches(
    SearchEngine::Literal,
    haystack,
    &packed,
    &Remap::Offset {
      pattern_offset: engine.pattern_offset,
    },
  )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ByteWindow {
  start: usize,
  end: usize,
}

fn regex_slot_is_match(slot: &RegexSlot, haystack: &str) -> Result<bool> {
  if !regex_prefilter_matches(slot, haystack)? {
    return Ok(false);
  }
  if slot.prefilter_window_bytes.is_some() {
    return Ok(!regex_slot_find_iter_packed_bytes(slot, haystack)?.is_empty());
  }
  Ok(regex_slot_engine(slot)?.is_match(haystack))
}

fn regex_slot_find_iter_packed_bytes(
  slot: &RegexSlot,
  haystack: &str,
) -> Result<Vec<u32>> {
  if !regex_prefilter_matches(slot, haystack)? {
    return Ok(Vec::new());
  }
  let engine = regex_slot_engine(slot)?;
  let Some(radius) = slot.prefilter_window_bytes else {
    return engine
      .find_iter_packed_bytes(haystack)
      .map_err(|error| Error::BuildRegex(error.to_string()));
  };
  regex_slot_find_iter_packed_windowed(slot, engine, haystack, radius)
}

fn regex_slot_find_iter_packed_windowed(
  slot: &RegexSlot,
  engine: &regex_core::RegexSet,
  haystack: &str,
  radius: usize,
) -> Result<Vec<u32>> {
  let Some(prefilter) = &slot.prefilter else {
    return engine
      .find_iter_packed_bytes(haystack)
      .map_err(|error| Error::BuildRegex(error.to_string()));
  };
  let hits = literal_prefilter_hit_ranges(prefilter, haystack)?;
  if hits.is_empty() {
    return Ok(Vec::new());
  }

  let windows = merged_prefilter_windows(haystack, &hits, radius);
  if slot.prefilter_window_needs_full_context {
    return regex_slot_find_iter_packed_windowed_full_context(
      engine, haystack, &windows,
    );
  }

  let mut triples = Vec::<[u32; MATCH_FIELDS]>::new();
  let mut needs_full_context = false;
  for window in &windows {
    let slice = str_span(haystack, window.start, window.end)?;
    let local = engine
      .find_iter_packed_bytes(slice)
      .map_err(|error| Error::BuildRegex(error.to_string()))?;
    let chunks = local.chunks_exact(MATCH_FIELDS);
    if !chunks.remainder().is_empty() {
      return Err(Error::InvalidPackedSearchResult {
        engine: SearchEngine::Regex,
        len: local.len(),
      });
    }
    for chunk in chunks {
      let [pattern, local_start, local_end] = chunk else {
        return Err(Error::InvalidPackedSearchResult {
          engine: SearchEngine::Regex,
          len: local.len(),
        });
      };
      let start = window.start.saturating_add(byte_index(*local_start));
      let end = window.start.saturating_add(byte_index(*local_end));
      if touches_internal_window_edge(*window, haystack.len(), start, end) {
        needs_full_context = true;
        continue;
      }
      triples.push([
        *pattern,
        match_offset(start, end)?,
        match_offset(end, start)?,
      ]);
    }
  }
  if needs_full_context {
    return regex_slot_find_iter_packed_windowed_full_context(
      engine, haystack, &windows,
    );
  }
  Ok(pack_regex_triples(triples))
}

fn regex_slot_find_iter_packed_windowed_full_context(
  engine: &regex_core::RegexSet,
  haystack: &str,
  windows: &[ByteWindow],
) -> Result<Vec<u32>> {
  let packed = engine
    .find_iter_packed_bytes(haystack)
    .map_err(|error| Error::BuildRegex(error.to_string()))?;
  let chunks = packed.chunks_exact(MATCH_FIELDS);
  if !chunks.remainder().is_empty() {
    return Err(Error::InvalidPackedSearchResult {
      engine: SearchEngine::Regex,
      len: packed.len(),
    });
  }
  let mut triples = Vec::<[u32; MATCH_FIELDS]>::new();
  for chunk in chunks {
    let [pattern, start, end] = chunk else {
      return Err(Error::InvalidPackedSearchResult {
        engine: SearchEngine::Regex,
        len: packed.len(),
      });
    };
    let start = byte_index(*start);
    let end = byte_index(*end);
    if !match_is_inside_prefilter_window(start, end, windows) {
      continue;
    }
    triples.push([
      *pattern,
      match_offset(start, end)?,
      match_offset(end, start)?,
    ]);
  }
  Ok(pack_regex_triples(triples))
}

fn pack_regex_triples(mut triples: Vec<[u32; MATCH_FIELDS]>) -> Vec<u32> {
  triples.sort_unstable();
  triples.dedup();
  let packed_capacity = triples.len().checked_mul(MATCH_FIELDS).unwrap_or(0);
  let mut packed = Vec::with_capacity(packed_capacity);
  for [pattern, start, end] in triples {
    packed.push(pattern);
    packed.push(start);
    packed.push(end);
  }
  packed
}

const fn touches_internal_window_edge(
  window: ByteWindow,
  haystack_len: usize,
  start: usize,
  end: usize,
) -> bool {
  (start == window.start && window.start > 0)
    || (end == window.end && window.end < haystack_len)
}

fn match_is_inside_prefilter_window(
  start: usize,
  end: usize,
  windows: &[ByteWindow],
) -> bool {
  windows
    .iter()
    .any(|window| window.start <= start && end <= window.end)
}

fn match_offset(value: usize, peer: usize) -> Result<u32> {
  u32::try_from(value).map_err(|_| Error::InvalidUtf8Span {
    start: value,
    end: peer,
  })
}

fn merged_prefilter_windows(
  haystack: &str,
  hits: &[(usize, usize)],
  radius: usize,
) -> Vec<ByteWindow> {
  let mut windows = Vec::with_capacity(hits.len());
  for (hit_start, hit_end) in hits {
    let start = floor_char_boundary(haystack, hit_start.saturating_sub(radius));
    let end = ceil_char_boundary(
      haystack,
      hit_end.saturating_add(radius).min(haystack.len()),
    );
    let Some(last) = windows.last_mut() else {
      windows.push(ByteWindow { start, end });
      continue;
    };
    if start <= last.end {
      last.end = last.end.max(end);
    } else {
      windows.push(ByteWindow { start, end });
    }
  }
  windows
}

fn floor_char_boundary(haystack: &str, mut index: usize) -> usize {
  index = index.min(haystack.len());
  while index > 0 && !haystack.is_char_boundary(index) {
    index = index.saturating_sub(1);
  }
  index
}

fn ceil_char_boundary(haystack: &str, mut index: usize) -> usize {
  index = index.min(haystack.len());
  while index < haystack.len() && !haystack.is_char_boundary(index) {
    index = index.saturating_add(1);
  }
  index
}

const fn should_parallel_split_literal_find(
  engines: &[SplitLiteralEngine],
  haystack: &str,
) -> bool {
  haystack.len() >= PARALLEL_FIND_MIN_BYTES
    && engines.len() >= PARALLEL_SPLIT_LITERAL_MIN_ENGINES
}

fn finalize_find_matches(
  matches: &mut Vec<Match>,
  overlap_strategy: OverlapStrategy,
) {
  if matches.len() <= 1 {
    return;
  }
  if overlap_strategy == OverlapStrategy::All {
    matches.sort_by_key(|found| found.start);
    return;
  }

  *matches = merge_and_select(std::mem::take(matches));
}

fn find_stats_for_engine(
  slot: usize,
  subslot: Option<usize>,
  engine: EngineKind,
  pattern_count: usize,
  pattern_bounds: PatternBounds,
  match_count: usize,
  start: Instant,
) -> FindStats {
  FindStats {
    slot,
    subslot,
    engine,
    pattern_count,
    first_pattern: pattern_bounds.first,
    last_pattern: pattern_bounds.last,
    match_count,
    elapsed_us: elapsed_us(start),
  }
}

fn engine_pattern_count(engine: &EngineSlot) -> usize {
  match engine {
    EngineSlot::Literal(slot) => literal_slot_pattern_count(slot),
    EngineSlot::SplitLiteral(slot) => slot
      .engines
      .iter()
      .map(split_literal_engine_pattern_count)
      .fold(0usize, usize::saturating_add),
    EngineSlot::Regex(slot) => slot.index_map.len(),
    EngineSlot::Fuzzy(slot) => slot.index_map.len(),
  }
}

fn engine_pattern_bounds(engine: &EngineSlot) -> PatternBounds {
  match engine {
    EngineSlot::Literal(slot) => literal_slot_pattern_bounds(slot),
    EngineSlot::SplitLiteral(slot) => {
      let count = engine_pattern_count(engine);
      let first = slot.engines.first().map(|split| split.pattern_offset);
      let last = count
        .checked_sub(1)
        .and_then(|index| u32::try_from(index).ok())
        .and_then(|index| first.and_then(|first| first.checked_add(index)));
      PatternBounds { first, last }
    }
    EngineSlot::Regex(slot) => pattern_bounds_from_index_map(&slot.index_map),
    EngineSlot::Fuzzy(slot) => pattern_bounds_from_index_map(&slot.index_map),
  }
}

fn literal_slot_pattern_count(slot: &LiteralSlot) -> usize {
  if slot.identity_map {
    return aho_pattern_count(&slot.engine);
  }
  slot.index_map.len()
}

fn literal_slot_pattern_bounds(slot: &LiteralSlot) -> PatternBounds {
  if slot.identity_map {
    return identity_pattern_bounds(literal_slot_pattern_count(slot));
  }
  pattern_bounds_from_index_map(&slot.index_map)
}

fn split_literal_engine_pattern_count(engine: &SplitLiteralEngine) -> usize {
  aho_pattern_count(&engine.engine)
}

fn split_literal_engine_pattern_bounds(
  engine: &SplitLiteralEngine,
) -> PatternBounds {
  let first = Some(engine.pattern_offset);
  let last = split_literal_engine_pattern_count(engine)
    .checked_sub(1)
    .and_then(|index| u32::try_from(index).ok())
    .and_then(|index| engine.pattern_offset.checked_add(index));
  PatternBounds { first, last }
}

const fn pattern_bounds_from_index_map(index_map: &[u32]) -> PatternBounds {
  PatternBounds {
    first: index_map.first().copied(),
    last: index_map.last().copied(),
  }
}

fn aho_pattern_count(engine: &aho_core::AhoCorasick) -> usize {
  usize::try_from(engine.pattern_count()).map_or(usize::MAX, |count| count)
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
  for chunk in chunks {
    let [local_pattern, start, end] = chunk else {
      return Err(Error::InvalidPackedSearchResult {
        engine,
        len: packed.len(),
      });
    };
    let (pattern, name) = remap_pattern(remap, *local_pattern)?;
    // Engines return UTF-8 byte offsets directly, so no conversion is needed.
    matches.push(Match {
      pattern,
      start: *start,
      end: *end,
      text: str_span(haystack, byte_index(*start), byte_index(*end))?
        .to_owned(),
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
    // Engines return UTF-8 byte offsets directly, so no conversion is needed.
    matches.push(Match {
      pattern,
      start: *start,
      end: *end,
      text: str_span(haystack, byte_index(*start), byte_index(*end))?
        .to_owned(),
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
  if let Some(prefilter) = &slot.prefilter
    && !literal_prefilter_matches(prefilter, haystack)?
  {
    return Ok(false);
  }
  if let Some(prefilter_regex) = &slot.prefilter_regex
    && !prefilter_regex.is_match(haystack)
  {
    return Ok(false);
  }
  Ok(true)
}

fn literal_prefilter_matches(
  prefilter: &LiteralPrefilter,
  haystack: &str,
) -> Result<bool> {
  match prefilter {
    LiteralPrefilter::Single { needle } => Ok(haystack.contains(needle)),
    LiteralPrefilter::Inline {
      needles,
      case_insensitive,
    } => Ok(needles.iter().any(|needle| {
      inline_literal_prefilter_matches(haystack, needle, *case_insensitive)
    })),
    LiteralPrefilter::Many(engine) => engine
      .is_match(haystack)
      .map_err(|error| Error::BuildLiteral(error.to_string())),
  }
}

fn literal_prefilter_hit_ranges(
  prefilter: &LiteralPrefilter,
  haystack: &str,
) -> Result<Vec<(usize, usize)>> {
  match prefilter {
    LiteralPrefilter::Single { needle } => {
      Ok(overlapping_literal_hit_ranges(haystack, needle))
    }
    LiteralPrefilter::Inline { .. } => {
      if literal_prefilter_matches(prefilter, haystack)? {
        Ok(vec![(0, haystack.len())])
      } else {
        Ok(Vec::new())
      }
    }
    LiteralPrefilter::Many(engine) => {
      let packed = engine
        .find_overlapping_iter_packed_bytes(haystack)
        .map_err(|error| Error::BuildLiteral(error.to_string()))?;
      let chunks = packed.chunks_exact(MATCH_FIELDS);
      if !chunks.remainder().is_empty() {
        return Err(Error::InvalidPackedSearchResult {
          engine: SearchEngine::Literal,
          len: packed.len(),
        });
      }
      let mut ranges = Vec::with_capacity(chunks.len());
      for chunk in chunks {
        let [_pattern, start, end] = chunk else {
          return Err(Error::InvalidPackedSearchResult {
            engine: SearchEngine::Literal,
            len: packed.len(),
          });
        };
        ranges.push((byte_index(*start), byte_index(*end)));
      }
      Ok(ranges)
    }
  }
}

fn overlapping_literal_hit_ranges(
  haystack: &str,
  needle: &str,
) -> Vec<(usize, usize)> {
  if needle.is_empty() {
    return vec![(0, haystack.len())];
  }

  let mut ranges = Vec::new();
  let mut offset = 0;
  while let Some(rest) = haystack.get(offset..) {
    let Some(relative_start) = rest.find(needle) else {
      break;
    };
    let start = offset.saturating_add(relative_start);
    ranges.push((start, start.saturating_add(needle.len())));
    offset = ceil_char_boundary(haystack, start.saturating_add(1));
  }
  ranges
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

/// Widens a [`Match`] `u32` byte offset to a `usize` index. `u32` always fits
/// `usize` on supported (>= 32-bit pointer) targets; the fallback keeps the
/// result in range so [`str_span`] reports a clean error otherwise.
fn byte_index(value: u32) -> usize {
  usize::try_from(value).unwrap_or(usize::MAX)
}

/// Stateful byte to UTF-16 offset translator, used only on the UTF-16 edge path
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
      unicode_boundaries: value.unicode_boundaries,
    }
  }
}
