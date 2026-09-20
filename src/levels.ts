import night00 from "../levels/night-00.json";
import night01 from "../levels/night-01.json";
import night02 from "../levels/night-02.json";
import night03 from "../levels/night-03.json";
import night04 from "../levels/night-04.json";
import night05 from "../levels/night-05.json";
import night06 from "../levels/night-06.json";
import type { LevelDef } from "./core/types";

export const levels: Record<string, LevelDef> = {
  "night-00": night00 as LevelDef,
  "night-01": night01 as LevelDef,
  "night-02": night02 as LevelDef,
  "night-03": night03 as LevelDef,
  "night-04": night04 as LevelDef,
  "night-05": night05 as LevelDef,
  "night-06": night06 as LevelDef,
};

export const nightOrder = [
  "night-00",
  "night-01",
  "night-02",
  "night-03",
  "night-04",
  "night-05",
  "night-06",
] as const;
