/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} value */
const stringList = (value) => {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  )
    throw new TypeError(
      "Anonymize contract fixture input must contain arrays of strings",
    );
  return value;
};

/** @param {unknown} value */
export const readDenyListData = (value) => {
  if (!isRecord(value) || !Array.isArray(value.sources))
    throw new TypeError(
      "Anonymize buildDenyList must return originals and sources arrays",
    );
  return {
    originals: stringList(value.originals),
    sources: value.sources.map(stringList),
  };
};

/** @param {unknown} value */
const regexMetadata = (value) => {
  // The perf harness skips patterns without metadata.
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || typeof value.label !== "string")
    throw new TypeError(
      "Anonymize REGEX_META entries must contain a string label",
    );
  return { ...value, label: value.label };
};

/** @param {unknown} value */
export const readRegexMetadata = (value) => {
  if (!Array.isArray(value))
    throw new TypeError("Anonymize REGEX_META must be an array");
  return value.map(regexMetadata);
};
