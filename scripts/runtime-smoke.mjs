import assert from "node:assert/strict";

import { TextSearch } from "../dist/index.mjs";

const search = new TextSearch([
  { pattern: "s.r.o.", literal: true, name: "company-type" },
  /\b\d{2}\.\d{2}\.\d{4}\b/,
  { pattern: "Novak", distance: 1, name: "surname" },
  "(?:Ing\\.|Mgr\\.)\\s+[A-Z][a-z]+",
]);

const haystack = "Ing. Jan Novak, s.r.o., narozen 15.03.1990.";
const matches = search.findIter(haystack);

assert.equal(search.isMatch(haystack), true);
assert.equal(matches.length, 4);
assert(matches.some((match) => match.text === "Ing. Jan"));
assert(matches.some((match) => match.text === "s.r.o." && match.name === "company-type"));
assert(
  matches.some(
    (match) =>
      match.text === "Novak" &&
      match.name === "surname" &&
      typeof match.distance === "number" &&
      match.distance <= 1,
  ),
);
assert(matches.some((match) => match.text === "15.03.1990"));
