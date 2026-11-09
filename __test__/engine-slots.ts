import type { EngineSlot, TextSearch } from "../src/text-search";

/**
 * Typed access to a TextSearch instance's engine slots, for tests that
 * observe or replace a slot's native engine.
 */
export const engineSlots = (search: TextSearch): readonly EngineSlot[] => {
  const slots: unknown = Reflect.get(search, "engines");
  if (!Array.isArray(slots)) throw new Error("TextSearch has no engine slots");
  return slots as EngineSlot[];
};

export type EngineSlotOf<K extends EngineSlot["type"]> = Extract<
  EngineSlot,
  { type: K }
>;

const isSlotOf = <K extends EngineSlot["type"]>(
  slot: EngineSlot | undefined,
  type: K,
): slot is EngineSlotOf<K> => slot?.type === type;

/** The slot at `index`, which must have the given type. */
export const engineSlot = <K extends EngineSlot["type"]>(
  search: TextSearch,
  index: number,
  type: K,
): EngineSlotOf<K> => {
  const slot = engineSlots(search)[index];
  if (!isSlotOf(slot, type))
    throw new Error(
      `engine slot ${index} is ${slot?.type ?? "missing"}, expected ${type}`,
    );
  return slot;
};

/** A lazily built engine that the test expects to exist already. */
export const built = <T>(engine: T | undefined, label: string): T => {
  if (engine === undefined) throw new Error(`${label} is not built`);
  return engine;
};

/** Every slot of the given type, in engine order. */
export const engineSlotsOf = <K extends EngineSlot["type"]>(
  search: TextSearch,
  type: K,
): EngineSlotOf<K>[] =>
  engineSlots(search).filter((slot): slot is EngineSlotOf<K> =>
    isSlotOf(slot, type),
  );

/** The native engine behind a built regex or fuzzy slot. */
export const regexOrFuzzyEngine = (slot: EngineSlot | undefined) => {
  if (slot?.type === "regex") return built(slot.rs, "regex engine");
  if (slot?.type === "fuzzy") return slot.fs;
  throw new Error(
    `expected a regex or fuzzy engine slot, got ${slot?.type ?? "none"}`,
  );
};
