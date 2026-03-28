#!/usr/bin/env bun
import {
  runPipeline,
  redactText,
  DEFAULT_ENTITY_LABELS,
  DEFAULT_OPERATOR_CONFIG,
  createPipelineContext,
} from "./packages/anonymize/src/index";
import type { Entity, PipelineConfig } from "./packages/anonymize/src/types";

const COLORS: Record<string, string> = {
  person: "#ff6b6b",
  organization: "#4ecdc4",
  address: "#45b7d1",
  date: "#f9ca24",
  "date of birth": "#f9ca24",
  "czech birth number": "#e056fd",
  "registration number": "#686de0",
  "tax identification number": "#686de0",
  "bank account number": "#22a6b3",
  iban: "#22a6b3",
  "email address": "#6ab04c",
  "phone number": "#7ed6df",
  "monetary amount": "#f0932b",
  url: "#95afc0",
};

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

const CONFIG: PipelineConfig = {
  threshold: 0.3,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableNameCorpus: true,
  enableDenyList: true,
  denyListCountries: ["CZ", "SK", "DE"],
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: true,
  enableZoneClassification: true,
  enableHotwordRules: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId: "eval",
};

const ctx = createPipelineContext();

const processDoc = async (path: string) => {
  const text = await Bun.file(path).text();
  const name = path.split("/").pop() ?? path;
  const entities = await runPipeline({
    fullText: text,
    config: CONFIG,
    gazetteerEntries: [],
    context: ctx,
  });
  entities.sort((a, b) => a.start - b.start);
  const { redactedText, redactionMap } = redactText(text, entities, DEFAULT_OPERATOR_CONFIG, ctx);
  return { name, text, entities, redactedText, redactionMap };
};

const dedup = (entities: Entity[]): Entity[] => {
  const used: Entity[] = [];
  for (const e of entities) {
    if (!used.some((u) => e.start < u.end && e.end > u.start)) used.push(e);
  }
  return used;
};

const highlight = (text: string, entities: Entity[]): string => {
  const sorted = dedup(entities.toSorted((a, b) => a.start - b.start));
  let result = "",
    pos = 0;
  for (const e of sorted) {
    if (e.start > pos) result += esc(text.slice(pos, e.start));
    const color = COLORS[e.label] ?? "#dfe6e9";
    result += `<span class="entity" style="background:${color}22;border-bottom:2px solid ${color}" title="${esc(e.label)} (${e.score.toFixed(2)}, ${e.source})">${esc(e.text)}</span>`;
    pos = e.end;
  }
  if (pos < text.length) result += esc(text.slice(pos));
  return result;
};

const buildHtml = (
  docs: { name: string; text: string; entities: Entity[]; redactedText: string }[],
): string => {
  const tabs = docs
    .map(
      (d, i) =>
        `<button class="tab${i === 0 ? " active" : ""}" onclick="showTab(${i})">${esc(d.name)}</button>`,
    )
    .join("");
  const panels = docs
    .map((d, i) => {
      const rows = d.entities
        .map(
          (e, j) =>
            `<tr><td>${j + 1}</td><td style="color:${COLORS[e.label] ?? "#333"}">${esc(e.label)}</td><td>${esc(e.text)}</td><td>${e.source}</td><td>${e.score.toFixed(2)}</td></tr>`,
        )
        .join("");
      return `<div class="panel${i === 0 ? " active" : ""}" id="p${i}"><div class="split"><div class="pane"><h3>Original</h3><div class="content">${highlight(d.text, d.entities)}</div></div><div class="pane"><h3>Redacted</h3><div class="content">${esc(d.redactedText)}</div></div></div><h3>Entities (${d.entities.length})</h3><table><tr><th>#</th><th>Label</th><th>Text</th><th>Source</th><th>Score</th></tr>${rows}</table></div>`;
    })
    .join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Eval</title><style>body{font-family:system-ui;margin:0;padding:16px;background:#f5f6fa}.tabs{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px}.tab{padding:6px 12px;border:1px solid #ddd;background:#fff;cursor:pointer;border-radius:4px 4px 0 0;font-size:12px}.tab.active{background:#0984e3;color:#fff}.panel{display:none}.panel.active{display:block}.split{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px}.pane{background:#fff;padding:12px;border-radius:6px;border:1px solid #ddd}.content{font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word}.entity{padding:1px 2px;border-radius:2px;cursor:help}table{width:100%;border-collapse:collapse;font-size:12px;background:#fff}th,td{padding:4px 8px;border:1px solid #eee;text-align:left}th{background:#f8f9fa}h3{margin:8px 0;font-size:14px}</style></head><body><h2>Eval — ${docs.length} docs, ${docs.reduce((s, d) => s + d.entities.length, 0)} entities</h2><div class="tabs">${tabs}</div>${panels}<script>function showTab(i){document.querySelectorAll('.tab').forEach((t,j)=>t.classList.toggle('active',j===i));document.querySelectorAll('.panel').forEach((p,j)=>p.classList.toggle('active',j===i))}</script></body></html>`;
};

const args = process.argv.slice(2);
let outputPath = "/tmp/eval-report.html";
const inputs: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--output" && args[i + 1]) {
    outputPath = args[i + 1];
    i++;
  } else {
    const arg = args[i];
    if (arg === undefined) {
      throw new Error(`Missing argument at index ${i}`);
    }
    inputs.push(arg);
  }
}
if (inputs.length === 0) {
  console.error("Usage: bun eval-html.ts <input.txt> [...]");
  process.exit(1);
}
const docs = await Promise.all(inputs.map(processDoc));
await Bun.write(outputPath, buildHtml(docs));
console.log(
  `${docs.length} docs, ${docs.reduce((s, d) => s + d.entities.length, 0)} entities → ${outputPath}`,
);
