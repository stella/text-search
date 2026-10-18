/** Validate fields consumed from the dynamically loaded build artifact.
 * @param {unknown} value
 */
export const readRuntimeSmokeMatches = (value) => {
  if (!Array.isArray(value)) throw new TypeError("Runtime smoke matches must be an array");
  return Array.from(
    value,
    /** @param {unknown} entry */ (entry) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("text" in entry) ||
        typeof entry.text !== "string"
      )
        throw new TypeError("Runtime smoke matches must contain text strings");
      const name = "name" in entry ? entry.name : undefined;
      const distance = "distance" in entry ? entry.distance : undefined;
      if (name !== undefined && typeof name !== "string")
        throw new TypeError("Runtime smoke match names must be strings when present");
      if (distance !== undefined && typeof distance !== "number")
        throw new TypeError("Runtime smoke match distances must be numbers when present");
      /** @satisfies {Pick<import("../src/types").Match, "text" | "name" | "distance">} */
      const match = {
        text: entry.text,
        ...(name === undefined ? {} : { name }),
        ...(distance === undefined ? {} : { distance }),
      };
      return match;
    },
  );
};
