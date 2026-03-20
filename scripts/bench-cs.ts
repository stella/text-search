import { readdir } from "node:fs/promises";
import { runPipeline, DEFAULT_ENTITY_LABELS } from "../packages/anonymize/src/index";

const CORPUS = "/tmp/anon-fixtures/inputs/cs/registr-smluv";
const config = { threshold: 0.5, enableTriggerPhrases: true, enableRegex: true, enableNameCorpus: true, enableDenyList: true, denyListCountries: ["CZ", "SK"], enableGazetteer: false, enableNer: false, enableConfidenceBoost: true, enableCoreference: true, labels: [...DEFAULT_ENTITY_LABELS, "date of birth"], workspaceId: "bench" };

const LABEL_ALIASES = { "czech birth number": "registration number" };
const normalizeLabel = (l) => LABEL_ALIASES[l] ?? l;

const files = await readdir(CORPUS);
const goldFiles = files.filter(f => f.endsWith(".gold.json"));

let tp = 0, fp = 0, fn = 0;
for (const gf of goldFiles) {
  const base = gf.replace(".gold.json", "");
  let text; try { text = await Bun.file(`${CORPUS}/${base}.txt`).text(); } catch { continue; }
  const gold = await Bun.file(`${CORPUS}/${gf}`).json();
  const t0 = performance.now();
  const predicted = await runPipeline(text, config, [], null);
  const ms = performance.now() - t0;

  const goldMatched = new Set();
  const predMatched = new Set();
  for (let pi = 0; pi < predicted.length; pi++) {
    const p = predicted[pi];
    for (let gi = 0; gi < gold.length; gi++) {
      if (goldMatched.has(gi)) continue;
      const g = gold[gi];
      if (normalizeLabel(p.label) !== normalizeLabel(g.label)) continue;
      const os = Math.max(p.start, g.start), oe = Math.min(p.end, g.end);
      if (oe <= os) continue;
      const shorter = Math.min(p.end - p.start, g.end - g.start);
      if ((oe - os) >= shorter * 0.5) { goldMatched.add(gi); predMatched.add(pi); break; }
    }
  }
  const ltp = goldMatched.size, lfp = predicted.length - predMatched.size, lfn = gold.length - goldMatched.size;
  tp += ltp; fp += lfp; fn += lfn;
  const p = ltp+lfp > 0 ? ltp/(ltp+lfp) : 0, r = ltp+lfn > 0 ? ltp/(ltp+lfn) : 0;
  const f1 = p+r > 0 ? 2*p*r/(p+r) : 0;
  const status = f1 >= 0.8 ? "OK" : f1 >= 0.5 ? "WARN" : "FAIL";
  console.log(`  [${status}] ${base.slice(0,55).padEnd(55)} P=${(p*100).toFixed(0).padStart(3)}% R=${(r*100).toFixed(0).padStart(3)}% F1=${(f1*100).toFixed(0).padStart(3)}% ${ms.toFixed(0).padStart(5)}ms (${ltp}/${ltp+lfn} gold, ${lfp} FP)`);
}
const p = tp+fp > 0 ? tp/(tp+fp) : 0, r = tp+fn > 0 ? tp/(tp+fn) : 0, f1 = p+r > 0 ? 2*p*r/(p+r) : 0;
console.log(`\n=== OVERALL ===\n  Precision: ${(p*100).toFixed(1)}%\n  Recall:    ${(r*100).toFixed(1)}%\n  F1:        ${(f1*100).toFixed(1)}%\n  (TP=${tp} FP=${fp} FN=${fn})`);
