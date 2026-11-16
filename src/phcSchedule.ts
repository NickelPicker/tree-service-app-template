/**
 * PHC service schedule — the corrected, science-based timings.
 *
 * Source: the deep-research report (CSU Extension primary) in
 * ~/workspace/research_notes/phc-treatment-recommendations-20261111-0005/report.md
 * and the "PHC Treatment Recommendations" page built from it.
 *
 * Timing decision: the science windows below REPLACE
 * the months in PHC_service_schedule.xlsx. The sheet's colours meant
 * nothing — any filled cell was just "treat this month" — so the sheet
 * windows are not preserved here; these months are the accepted ones.
 *
 * The user holds a Colorado Qualified Supervisor (QS) pesticide licence,
 * so every treatment listed here is one he is allowed to apply.
 *
 * `months` are 1–12 (Jan–Dec). `kind`:
 *   "chemical" — a spray / injection / drench to quote and apply.
 *   "cultural"  — no chemical treatment exists; prune / assess / remove.
 *   "service"   — a non-chemical service (monitoring, samples, flush).
 * `stock` is against the inventory from the Breezeworks records:
 *   "have"    — the recommended product is already stocked.
 *   "partial" — part of the recommendation is stocked, part must be sourced.
 *   "need"    — must be sourced.
 *   "none"    — no product applies (cultural / service rows).
 */

import type { Estimate } from "./types";
import { todayStr, uid } from "./utils";

export type PhcKind = "chemical" | "cultural" | "service";
export type PhcStock = "have" | "partial" | "need" | "none";

export interface PhcService {
  id: string;
  name: string;
  group: string;
  hosts: string;
  /** Active ingredient + example product, short. */
  treatment: string;
  method: string;
  /** Science (accepted) application months, 1–12. */
  months: number[];
  kind: PhcKind;
  stock: PhcStock;
  /** Short flag shown in the briefing, e.g. "Do not sell routinely". */
  note?: string;
  /** True when the item must NOT be quoted as a routine service. */
  doNotSell?: boolean;
}

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function monthName(m: number): string {
  return MONTH_NAMES[(m - 1 + 12) % 12] ?? "";
}

export function formatMonths(months: number[]): string {
  if (months.length === 0) return "—";
  if (months.length === 12) return "Year-round";
  // Group consecutive months into ranges.
  const sorted = [...months].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    ranges.push(
      start === prev
        ? monthName(start).slice(0, 3)
        : `${monthName(start).slice(0, 3)}–${monthName(prev).slice(0, 3)}`,
    );
    start = cur;
    prev = cur;
  }
  return ranges.join(", ");
}

export const PHC_SERVICES: PhcService[] = [
  // ---- Aphids ----
  {
    id: "cooley-spruce-gall",
    name: "Cooley spruce gall",
    group: "Aphids",
    hosts: "Spruce, fir",
    treatment: "Permethrin (Astro) or carbaryl foliar; horticultural oil alternative",
    method: "Foliar spray to undersides of terminals",
    months: [3, 4, 10, 11],
    kind: "chemical",
    stock: "partial",
    note: "Ineffective once galls form — treat before late April or in fall.",
  },
  {
    id: "giant-conifer-aphid",
    name: "Giant conifer aphid",
    group: "Aphids",
    hosts: "Pine, spruce, juniper",
    treatment: "Insecticidal soap / pyrethrin; dinotefuran systemic if severe",
    method: "Water jet / foliar contact; soil drench",
    months: [3, 4, 5, 6],
    kind: "chemical",
    stock: "partial",
  },
  {
    id: "leaf-curling-aphid",
    name: "Leaf curling aphid",
    group: "Aphids",
    hosts: "Ash",
    treatment: "Imidacloprid / dinotefuran soil drench",
    method: "Soil drench / injection",
    months: [4, 5],
    kind: "chemical",
    stock: "partial",
    note: "Systemic only — contact sprays can't reach aphids inside curls.",
  },
  {
    id: "woolly-aphid",
    name: "Woolly aphid",
    group: "Aphids",
    hosts: "Apple, spruce, fir",
    treatment: "Horticultural oil dormant + dinotefuran systemic",
    method: "Dormant oil / soil systemic",
    months: [3, 4, 5, 6],
    kind: "chemical",
    stock: "partial",
  },
  {
    id: "aphids-general",
    name: "Aphids",
    group: "Aphids",
    hosts: "Everything",
    treatment: "Insecticidal soap / pyrethrin; dinotefuran systemic for hidden aphids",
    method: "Foliar contact / soil systemic",
    months: [3, 4, 5, 6, 7, 8],
    kind: "chemical",
    stock: "partial",
    note: "Treat on threshold only — don't spray blooming plants.",
  },
  // ---- Anthracnose ----
  {
    id: "anthracnose-ash",
    name: "Anthracnose",
    group: "Anthracnose",
    hosts: "Ash",
    treatment: "Chlorothalonil (Daconil) or thiophanate-methyl foliar",
    method: "Foliar spray at bud swell",
    months: [3, 4, 5],
    kind: "chemical",
    stock: "need",
    note: "Fungicide after leaf expansion does not cure — bud swell only.",
  },
  {
    id: "anthracnose-sycamore",
    name: "Anthracnose",
    group: "Anthracnose",
    hosts: "Sycamore",
    treatment: "Chlorothalonil / thiophanate-methyl foliar; propiconazole injection for large trees",
    method: "Foliar spray / trunk injection",
    months: [3, 4, 10, 11],
    kind: "chemical",
    stock: "need",
  },
  // ---- Bacterial wetwood ----
  {
    id: "bacterial-wetwood",
    name: "Bacterial wetwood / slime flux",
    group: "Bacterial wetwood",
    hosts: "Deciduous trees",
    treatment: "No chemical treatment — none effective",
    method: "Water, avoid wounding, disinfect tools, cut away dead bark",
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    kind: "cultural",
    stock: "none",
    note: "No drain tubes — they spread the bacteria.",
  },
  // ---- Bark beetles ----
  {
    id: "ambrosia-beetle",
    name: "Ambrosia beetles",
    group: "Bark beetles",
    hosts: "Cherry, plum",
    treatment: "Permethrin (Astro) or bifenthrin trunk spray",
    method: "Trunk spray, full coverage",
    months: [3, 4, 5],
    kind: "chemical",
    stock: "partial",
  },
  {
    id: "douglas-fir-beetle",
    name: "Douglas-fir beetle",
    group: "Bark beetles",
    hosts: "Fir",
    treatment: "Carbaryl, permethrin or bifenthrin bark spray",
    method: "Bark spray, full trunk",
    months: [4, 5, 6],
    kind: "chemical",
    stock: "partial",
    note: "Preventive only — cannot save an infested tree.",
  },
  {
    id: "elm-bark-beetle",
    name: "Elm bark beetle",
    group: "Bark beetles",
    hosts: "Elm",
    treatment: "No practical chemical control",
    method: "Sanitation — remove and destroy dead elm wood promptly",
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    kind: "cultural",
    stock: "none",
  },
  {
    id: "ips-beetle",
    name: "Ips beetles",
    group: "Bark beetles",
    hosts: "Spruce",
    treatment: "Carbaryl, permethrin or bifenthrin bark spray",
    method: "Bark spray incl. branches over 1 in",
    months: [3, 4, 6, 7],
    kind: "chemical",
    stock: "partial",
  },
  {
    id: "mountain-pine-beetle",
    name: "Mountain pine beetle",
    group: "Bark beetles",
    hosts: "Pine",
    treatment: "Carbaryl (2-yr) or permethrin / bifenthrin bark spray",
    method: "Bark spray, entire trunk",
    months: [4, 5, 6],
    kind: "chemical",
    stock: "partial",
    note: "Spray before the July flight — sprayed after June may already be attacked.",
  },
  {
    id: "pitch-mass-borer",
    name: "Pitch mass borer",
    group: "Bark beetles",
    hosts: "Piñon pine",
    treatment: "Permethrin or bifenthrin trunk spray",
    method: "Trunk spray around active sites",
    months: [5, 6, 7, 8],
    kind: "chemical",
    stock: "partial",
  },
  {
    id: "turpentine-beetle",
    name: "Turpentine beetle",
    group: "Bark beetles",
    hosts: "Scotch pine",
    treatment: "Bifenthrin or permethrin lower-trunk spray",
    method: "Lower 12 ft bark spray",
    months: [4, 5],
    kind: "chemical",
    stock: "partial",
  },
  // ---- Borers ----
  {
    id: "bronze-birch-borer",
    name: "Bronze birch borer",
    group: "Borers",
    hosts: "Birch",
    treatment: "Emamectin benzoate injection or permethrin trunk spray",
    method: "Trunk injection / spray",
    months: [5, 6, 7],
    kind: "chemical",
    stock: "partial",
    note: "Inject in May–June, before flight.",
  },
  {
    id: "emerald-ash-borer",
    name: "Emerald ash borer",
    group: "Borers",
    hosts: "Ash",
    treatment: "Emamectin benzoate trunk injection (2–3 yr)",
    method: "Trunk injection shortly after bud break",
    months: [5, 6],
    kind: "chemical",
    stock: "have",
    note: "Gold standard. Rescue possible to ~30% canopy thinning.",
  },
  {
    id: "locust-borer",
    name: "Locust borer",
    group: "Borers",
    hosts: "Locust",
    treatment: "Permethrin / bifenthrin trunk spray",
    method: "Trunk spray at flight",
    months: [8, 9],
    kind: "chemical",
    stock: "partial",
    note: "Flight is Aug–Sep — spring sprays miss it entirely.",
  },
  {
    id: "peach-tree-borer",
    name: "Peach tree borer",
    group: "Borers",
    hosts: "Peach",
    treatment: "Permethrin trunk spray, lower trunk + root flare, 2 sprays",
    method: "Lower-trunk spray",
    months: [7, 8],
    kind: "chemical",
    stock: "partial",
    note: "Once larvae are inside, insecticides don't work.",
  },
  {
    id: "poplar-borer",
    name: "Poplar borer",
    group: "Borers",
    hosts: "Aspen",
    treatment: "Permethrin / bifenthrin trunk spray; emamectin injection",
    method: "Trunk spray / injection",
    months: [6, 7, 8],
    kind: "chemical",
    stock: "partial",
  },
  {
    id: "shothole-borer",
    name: "Shothole borer",
    group: "Borers",
    hosts: "Cherry, plum",
    treatment: "Permethrin / bifenthrin trunk spray + sanitation",
    method: "Remove dead wood, then trunk spray",
    months: [4, 5, 7, 8],
    kind: "chemical",
    stock: "partial",
  },
  {
    id: "walnut-twig-beetle",
    name: "Walnut twig beetle",
    group: "Borers",
    hosts: "Walnut",
    treatment: "No proven chemical cure (Thousand Cankers)",
    method: "Prune infected limbs, keep tree vigorous, don't move walnut wood",
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    kind: "cultural",
    stock: "none",
  },

  // ---- Canker ----
  {
    id: "cytospora-deciduous",
    name: "Cytospora canker",
    group: "Canker",
    hosts: "Aspen, cottonwood, maple, willow",
    treatment: "No fungicide works",
    method: "Prune in dry / dormant weather, disinfect tools, destroy debris",
    months: [11, 12, 1, 2, 3],
    kind: "cultural",
    stock: "none",
  },
  {
    id: "cytospora-coniferous",
    name: "Cytospora canker",
    group: "Canker",
    hosts: "Spruce",
    treatment: "No fungicide works",
    method: "Prune in winter on a dry, sunny day",
    months: [12, 1, 2],
    kind: "cultural",
    stock: "none",
  },
  {
    id: "thyronectria",
    name: "Thyronectria canker",
    group: "Canker",
    hosts: "Locust",
    treatment: "Do not use fungicides",
    method: "Prune 4–6 in below the canker in dry weather, disinfect tools",
    months: [12, 1, 2, 3, 4],
    kind: "cultural",
    stock: "none",
  },
  // ---- Fire blight ----
  {
    id: "fire-blight",
    name: "Fire blight",
    group: "Fire blight",
    hosts: "Apple, crabapple, hawthorn, mountain ash, pear",
    treatment: "Streptomycin (Agri-Mycin 17) bloom spray; copper at silver tip",
    method: "Foliar bloom spray; dormant copper",
    months: [3, 4, 5],
    kind: "chemical",
    stock: "need",
    note: "Preventive only — nothing cures it once symptoms show.",
  },
  // ---- Fungal ----
  {
    id: "blue-stain",
    name: "Blue stain",
    group: "Fungal",
    hosts: "Pine, spruce",
    treatment: "No direct fungicide — prevent the vector bark beetles",
    method: "Sanitation — remove infested trees promptly; bark-beetle prevention (see Bark beetles)",
    months: [4, 5, 6, 7],
    kind: "cultural",
    stock: "none",
    note: "No fungicide treats stain in a living tree — the control is the bark-beetle vector.",
  },
  {
    id: "cedar-apple-rust",
    name: "Cedar-apple rust",
    group: "Fungal",
    hosts: "Apple, crabapple, hawthorn, juniper",
    treatment: "Myclobutanil / propiconazole / chlorothalonil foliar (rosaceous host)",
    method: "Foliar spray; prune galls on juniper (no spray)",
    months: [4, 5],
    kind: "chemical",
    stock: "need",
    note: "Too late once lesions are seen — preventive only.",
  },
  {
    id: "dutch-elm-disease",
    name: "Dutch elm disease",
    group: "Fungal",
    hosts: "American elm",
    treatment: "Propiconazole (Propizol / Alamo) trunk injection",
    method: "Trunk injection, spring before beetle flight",
    months: [4, 5],
    kind: "chemical",
    stock: "need",
    note: "Reliant is NOT a substitute. Won't work past ~15% canopy loss.",
  },
  {
    id: "leaf-spot",
    name: "Leaf spot",
    group: "Fungal",
    hosts: "Apple, aspen, cottonwood",
    treatment: "Chlorothalonil / myclobutanil / copper foliar",
    method: "Foliar spray at petal fall / first leaves",
    months: [4, 5],
    kind: "chemical",
    stock: "need",
  },
  {
    id: "powdery-mildew",
    name: "Powdery mildew",
    group: "Fungal",
    hosts: "Everything",
    treatment: "Myclobutanil / sulfur / chlorothalonil foliar",
    method: "Foliar spray from bud break, every 7–14 days",
    months: [5, 6, 7],
    kind: "chemical",
    stock: "need",
  },
  {
    id: "rhizosphaera",
    name: "Rhizosphaera needle cast",
    group: "Fungal",
    hosts: "Spruce",
    treatment: "Chlorothalonil (preferred) / copper hydroxide foliar",
    method: "Foliar spray when new needles are half elongated, repeat in June",
    months: [5, 6],
    kind: "chemical",
    stock: "need",
    note: "Needs 2 consecutive years — infected needles don't recover.",
  },
  {
    id: "shothole-disease",
    name: "Shothole disease",
    group: "Fungal",
    hosts: "Cherry, plum",
    treatment: "Fixed copper or chlorothalonil foliar",
    method: "Foliar spray — main timing fall at 50% leaf drop",
    months: [3, 4, 10, 11],
    kind: "chemical",
    stock: "need",
  },
  // ---- Iron chlorosis ----
  {
    id: "iron-chlorosis",
    name: "Iron chlorosis",
    group: "Iron chlorosis",
    hosts: "Maple, oak",
    treatment: "EDDHA chelated iron soil treatment; iron sulfate + sulfur",
    method: "Soil injection / trunk injection",
    months: [4, 5],
    kind: "chemical",
    stock: "partial",
    note: "Spring is the window — September is too late. Verify stock is EDDHA.",
  },
  // ---- Japanese beetle ----
  {
    id: "japanese-beetle",
    name: "Japanese beetle",
    group: "Japanese beetle",
    hosts: "Flowering trees and plants",
    treatment: "Carbaryl / permethrin foliar (adults); chlorantraniliprole or nematodes (grubs)",
    method: "Foliar spray; soil / granular for grubs",
    months: [6, 7, 8, 9],
    kind: "chemical",
    stock: "partial",
    note: "Do NOT spray blooming plants while pollinators are active.",
  },
  // ---- Leaf beetle ----
  {
    id: "elm-leaf-beetle",
    name: "Elm leaf beetle",
    group: "Leaf beetle",
    hosts: "Elm",
    treatment: "Spinosad / carbaryl / permethrin foliar",
    method: "Foliar spray; trunk band for descending larvae",
    months: [5, 6, 7],
    kind: "chemical",
    stock: "partial",
  },
  // ---- Leafhopper ----
  {
    id: "leafhopper",
    name: "Leafhopper",
    group: "Leafhopper",
    hosts: "Locust",
    treatment: "Permethrin / bifenthrin / carbaryl foliar",
    method: "Foliar spray",
    months: [5, 6],
    kind: "chemical",
    stock: "partial",
    note: "Usually no treatment needed — treat only at threshold.",
  },
  // ---- Leaf miner ----
  {
    id: "leafminer-elm",
    name: "Leaf miner",
    group: "Leaf miner",
    hosts: "Siberian elm",
    treatment: "Imidacloprid / dinotefuran soil drench",
    method: "Soil drench / injection",
    months: [4, 5],
    kind: "chemical",
    stock: "partial",
    note: "Contact sprays can't reach larvae inside the leaf.",
  },
  {
    id: "leafminer-hawthorn",
    name: "Leaf miner",
    group: "Leaf miner",
    hosts: "Hawthorn",
    treatment: "Imidacloprid / dinotefuran soil; abamectin foliar",
    method: "Soil / trunk / foliar systemic",
    months: [4, 5],
    kind: "chemical",
    stock: "partial",
    note: "Timing provisional — confirm species before quoting.",
  },
  // ---- Mealybugs ----
  {
    id: "mealybug",
    name: "Mealybugs",
    group: "Mealybugs",
    hosts: "Hawthorn",
    treatment: "Pyriproxyfen / buprofezin IGR + horticultural oil; dinotefuran after bloom",
    method: "Foliar IGR + oil; soil / trunk systemic",
    months: [2, 3, 4, 8, 9],
    kind: "chemical",
    stock: "partial",
    note: "Bee warning — no neonics before or during hawthorn bloom.",
  },
  // ---- Mites ----
  {
    id: "spider-mites",
    name: "Spider mites",
    group: "Mites",
    hosts: "Everything",
    treatment: "Abamectin / bifenazate / bifenthrin; horticultural oil / soap",
    method: "Foliar spray, thorough underside coverage",
    months: [3, 4, 5, 6, 7, 8, 9, 10],
    kind: "chemical",
    stock: "need",
    note: "Do NOT use stocked permethrin for mites — it flares them.",
  },
  // ---- Moths and caterpillars ----
  {
    id: "codling-moth",
    name: "Codling moth",
    group: "Moths and caterpillars",
    hosts: "Apple, pear",
    treatment: "Spinosad + oil; or Cyd-X virus; carbaryl at 250 DD",
    method: "Foliar spray timed to egg hatch (pheromone trap + degree-days)",
    months: [5, 6, 7, 8],
    kind: "chemical",
    stock: "need",
  },
  {
    id: "oak-leafroller",
    name: "Oak leafroller",
    group: "Moths and caterpillars",
    hosts: "Scrub oak",
    treatment: "Bt kurstaki (DiPel / Foray) on young larvae",
    method: "Foliar spray",
    months: [5, 6],
    kind: "chemical",
    stock: "need",
  },
  {
    id: "pine-tip-moth",
    name: "Pine tip moth",
    group: "Moths and caterpillars",
    hosts: "Pine",
    treatment: "Permethrin / bifenthrin foliar; acephate for tunnelling larvae",
    method: "Foliar spray to new shoots",
    months: [4, 5, 7],
    kind: "chemical",
    stock: "partial",
  },
  {
    id: "tussock-moth",
    name: "Tussock moth",
    group: "Moths and caterpillars",
    hosts: "Fir",
    treatment: "Bt kurstaki preferred; acephate / carbaryl on small larvae",
    method: "Foliar spray",
    months: [5, 6],
    kind: "chemical",
    stock: "partial",
  },
  {
    id: "western-spruce-budworm",
    name: "Western spruce budworm",
    group: "Moths and caterpillars",
    hosts: "Spruce",
    treatment: "Bt kurstaki preferred",
    method: "Foliar spray on early larvae",
    months: [5, 6],
    kind: "chemical",
    stock: "need",
  },
  // ---- Nutrient issues ----
  {
    id: "spring-fertilization",
    name: "Spring fertilization",
    group: "Nutrient issues",
    hosts: "Everything",
    treatment: "Slow-release N, 0.1–0.4 lb N / 100 ft² (soil-test first)",
    method: "Deep-root soil injection",
    months: [3, 4],
    kind: "chemical",
    stock: "have",
  },
  {
    id: "summer-fertilization",
    name: "Summer fertilization",
    group: "Nutrient issues",
    hosts: "Stressed plants",
    treatment: "Do NOT fertilise stressed / drought trees in summer",
    method: "Water and mulch first; light low-N only if diagnosed and irrigated",
    months: [6, 7, 8],
    kind: "service",
    stock: "have",
    doNotSell: true,
    note: "Do not sell as a routine summer service.",
  },
  {
    id: "fall-fertilization",
    name: "Fall fertilization",
    group: "Nutrient issues",
    hosts: "Everything",
    treatment: "Slow-release N (or low-N) after leaf drop, soil above 40°F",
    method: "Deep-root / broadcast",
    months: [10, 11],
    kind: "chemical",
    stock: "have",
  },
  {
    id: "rx-fertilization",
    name: "Rx fertilization",
    group: "Nutrient issues",
    hosts: "Specific plants as needed",
    treatment: "Soil-test prescription (CSU lab) — correct the diagnosed deficiency",
    method: "Per lab prescription",
    months: [3, 4, 10, 11],
    kind: "chemical",
    stock: "have",
  },
  // ---- Plant bugs ----
  {
    id: "plant-bug",
    name: "Plant bugs",
    group: "Plant bugs",
    hosts: "Boxelder, locust, sycamore",
    treatment: "2% horticultural oil late May–Jun; permethrin / bifenthrin if threshold met",
    method: "Foliar spray",
    months: [5, 6],
    kind: "chemical",
    stock: "partial",
  },
  // ---- Scale ----
  {
    id: "european-elm-scale",
    name: "European elm scale",
    group: "Scale",
    hosts: "American elm",
    treatment: "Dormant horticultural oil + crawler spray (cyfluthrin / soap / dinotefuran)",
    method: "Dormant oil; crawler foliar; systemic",
    months: [3, 4, 5, 6],
    kind: "chemical",
    stock: "partial",
    note: "Acephate must NOT be used on American elm.",
  },
  {
    id: "kermes-scale",
    name: "Kermes scale",
    group: "Scale",
    hosts: "Red oak",
    treatment: "Dormant horticultural oil; crawler spray permethrin / carbaryl",
    method: "Dormant oil; crawler foliar",
    months: [3, 4, 6],
    kind: "chemical",
    stock: "partial",
  },
  {
    id: "lecanium-scale",
    name: "Lecanium scale",
    group: "Scale",
    hosts: "Fruit trees, maples, English oak",
    treatment: "Dormant oil; crawler spray; dinotefuran systemic",
    method: "Dormant oil; crawler foliar; systemic",
    months: [3, 4, 6, 7, 8, 9],
    kind: "chemical",
    stock: "partial",
  },
  {
    id: "pine-needle-scale",
    name: "Pine needle scale",
    group: "Scale",
    hosts: "Long-needle pines",
    treatment: "Dormant oil 2%; crawler sprays (soap / oil / permethrin)",
    method: "Dormant oil; crawler foliar",
    months: [3, 4, 5, 7],
    kind: "chemical",
    stock: "partial",
    note: "1st crawler generation is late Apr–May — don't wait for June.",
  },
  // ---- Ash yellows ----
  {
    id: "ash-yellows",
    name: "Ash yellows",
    group: "Ash yellows",
    hosts: "Ash",
    treatment: "No cure",
    method: "Test suspect trees; remove positives; vigour care for the rest",
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    kind: "cultural",
    stock: "none",
  },
  // ---- Weevils ----
  {
    id: "black-vine-weevil",
    name: "Black vine / rhododendron weevil",
    group: "Weevils",
    hosts: "Rhododendron",
    treatment: "Permethrin / bifenthrin foliar (adults); imidacloprid soil or nematodes (larvae)",
    method: "Foliar; soil drench",
    months: [5, 6, 7, 8, 9, 10, 11],
    kind: "chemical",
    stock: "partial",
  },
  {
    id: "white-pine-weevil",
    name: "White pine weevil",
    group: "Weevils",
    hosts: "Spruce",
    treatment: "Permethrin / bifenthrin terminal spray; prune wilted terminals",
    method: "Terminal foliar; pruning; soil systemic",
    months: [4, 5, 6, 7, 10, 11],
    kind: "chemical",
    stock: "partial",
  },
  // ---- Other services ----
  {
    id: "anti-transpirant",
    name: "Anti-transpirant",
    group: "Other services",
    hosts: "Evergreens and newly planted trees",
    treatment: "Wilt-Pruf / Wilt Stop pinene film",
    method: "Foliar spray",
    months: [10, 11],
    kind: "chemical",
    stock: "need",
    note: "Evidence is mixed — watering and wind protection matter more.",
  },
  {
    id: "cambistat",
    name: "Cambistat",
    group: "Other services",
    hosts: "Drought stress, construction damage",
    treatment: "Paclobutrazol (Cambistat 22.3%)",
    method: "Soil injection / basal drench",
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    kind: "chemical",
    stock: "have",
    note: "Do NOT treat severely stressed or rapidly declining trees.",
  },
  {
    id: "dormant-oil",
    name: "Dormant oil",
    group: "Other services",
    hosts: "Trees with prior insect issues",
    treatment: "Horticultural (narrow-range mineral) oil, 2–3% dormant rate",
    method: "Dormant spray, thorough coverage",
    months: [3, 4],
    kind: "chemical",
    stock: "need",
  },
  {
    id: "ipm",
    name: "IPM monitoring",
    group: "Other services",
    hosts: "Everything",
    treatment: "No chemical — scouting, traps, degree-days, thresholds",
    method: "Scheduled scouting + pheromone traps + photo records",
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    kind: "service",
    stock: "none",
    note: "This is what keeps the other timings right.",
  },
  {
    id: "sodium-flush",
    name: "Sodium flush / salt remediation",
    group: "Other services",
    hosts: "Parking-lot trees and trees by business entrances",
    treatment: "Leach salts with water; gypsum (calcium sulfate)",
    method: "Deep slow watering; gypsum incorporation",
    months: [3, 4, 10, 11],
    kind: "service",
    stock: "need",
    note: "Do NOT use lime — it raises pH in already-alkaline Colorado soils.",
  },
  {
    id: "soil-sample",
    name: "Soil sample",
    group: "Other services",
    hosts: "When needed",
    treatment: "CSU Soil, Water & Plant Testing Lab",
    method: "Lab submission (mail / drop-off)",
    months: [3, 4, 10],
    kind: "service",
    stock: "need",
  },
  {
    id: "stump-treatment",
    name: "Stump treatment",
    group: "Other services",
    hosts: "Stumps that send runners",
    treatment: "Triclopyr (Garlon 4) cut-stump",
    method: "Paint the cambium ring within minutes of cutting",
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    kind: "chemical",
    stock: "have",
    note: "Best Aug–Oct (downward translocation).",
  },
  {
    id: "tissue-sample",
    name: "Tissue sample",
    group: "Other services",
    hosts: "When needed",
    treatment: "CSU lab plant analysis",
    method: "Lab submission",
    months: [5, 6, 7],
    kind: "service",
    stock: "need",
  },
  {
    id: "water-sample",
    name: "Water sample",
    group: "Other services",
    hosts: "When needed",
    treatment: "CSU lab water test (EC, pH, bicarbonate, salts)",
    method: "Lab submission",
    months: [3, 4],
    kind: "service",
    stock: "need",
  },
];

/** Services whose accepted window includes the given month (1–12). */
export function phcServicesForMonth(month: number): PhcService[] {
  return PHC_SERVICES.filter((s) => s.months.includes(month));
}

export const STOCK_LABEL: Record<PhcStock, string> = {
  have: "In stock",
  partial: "Partly in stock",
  need: "Need to source",
  none: "No product",
};

export const STOCK_BADGE: Record<PhcStock, string> = {
  have: "bg-emerald-100 text-emerald-800",
  partial: "bg-amber-100 text-amber-800",
  need: "bg-red-100 text-red-800",
  none: "bg-slate-100 text-slate-600",
};

/**
 * The sheet's original months (PHC_service_schedule.xlsx), per service.
 * The sheet's colours meant nothing — any filled cell was just "treat
 * this month" — so these are the months as the sheet had them, before
 * the science corrections in `months` above. Empty = the sheet had no
 * months filled for that service (its timing comes from the research
 * only). Host rows in the sheet collapse into one service here (the
 * five Fire Blight host rows are all "fire-blight"); the exceptions
 * are Anthracnose, whose two host rows are two services (ash /
 * sycamore), and Leaf Miner, which the research splits into two
 * services (elm / hawthorn) from one sheet row.
 *
 * Reconciliation (2026-11-12, checked against the xlsx itself): the
 * sheet has 69 rows with month fills — 68 belong to services below
 * and 1 is a blank row (xlsx row 106, fills but no pest name) that
 * maps to nothing. All 83 named/host rows in the sheet map into
 * these 67 services; no service is missing from the sheet and no
 * sheet row is missing from the catalog except the blank row and the
 * column header.
 */
export const SHEET_MONTHS: Record<string, number[]> = {
  "cooley-spruce-gall": [2, 3, 4, 5, 6],
  "giant-conifer-aphid": [3, 4, 5, 6, 7, 8, 9, 10],
  "leaf-curling-aphid": [4, 5, 6, 7, 8, 9],
  "woolly-aphid": [3, 4, 5, 6, 7, 8, 9, 10],
  "aphids-general": [3, 4, 5, 6, 7, 8, 9, 10],
  "anthracnose-ash": [3, 4, 5, 6, 7, 8, 9, 10],
  "anthracnose-sycamore": [6, 7],
  "bacterial-wetwood": [3, 4, 5, 6, 7, 8, 9, 10],
  "ambrosia-beetle": [2, 3, 6, 7],
  "douglas-fir-beetle": [2, 3, 6, 7, 10, 11],
  "elm-bark-beetle": [3, 4, 5, 6, 7, 8, 9],
  "ips-beetle": [2, 3, 6, 7, 10, 11],
  "mountain-pine-beetle": [2, 3, 6, 7, 10, 11],
  "pitch-mass-borer": [5, 6],
  "turpentine-beetle": [2, 3, 6, 7, 10, 11],
  "bronze-birch-borer": [6],
  "emerald-ash-borer": [4, 5, 6, 7, 8, 9, 10],
  "locust-borer": [4, 5],
  "peach-tree-borer": [6],
  "poplar-borer": [4, 5, 6],
  "shothole-borer": [3, 4, 7, 8],
  "walnut-twig-beetle": [4, 5, 6, 7, 8, 9],
  "cytospora-deciduous": [3, 4, 5, 6, 7, 8, 9, 10],
  "cytospora-coniferous": [3, 4, 5, 6, 7, 8, 9, 10],
  thyronectria: [3, 4, 5, 6, 7, 8, 9, 10],
  "fire-blight": [3, 4, 5, 6, 7, 8, 9, 10],
  "blue-stain": [4, 5, 6, 7, 8, 9, 10],
  "cedar-apple-rust": [4, 5],
  "dutch-elm-disease": [6, 7, 8],
  "leaf-spot": [4, 5],
  "powdery-mildew": [8, 9, 10, 11],
  rhizosphaera: [3, 4, 5, 6, 7, 8, 9, 10],
  "shothole-disease": [4, 5],
  "iron-chlorosis": [9],
  "japanese-beetle": [7],
  "elm-leaf-beetle": [3, 4, 5],
  leafhopper: [3, 4, 5],
  "leafminer-elm": [3, 4, 5],
  "leafminer-hawthorn": [],
  mealybug: [1, 2, 3, 4, 10, 11, 12],
  "spider-mites": [3, 4, 5, 6, 7, 8, 9, 10, 11],
  "codling-moth": [4, 5],
  "oak-leafroller": [4, 5],
  "pine-tip-moth": [4, 5],
  "tussock-moth": [4, 5],
  "western-spruce-budworm": [4, 5],
  "spring-fertilization": [],
  "summer-fertilization": [],
  "fall-fertilization": [],
  "rx-fertilization": [],
  "plant-bug": [3, 4, 5, 6, 7, 8, 9, 10, 11],
  "european-elm-scale": [6],
  "kermes-scale": [3, 4, 5, 6, 7, 10, 11],
  "lecanium-scale": [3, 4, 5, 6, 7, 8],
  "pine-needle-scale": [6, 7, 8, 9],
  "ash-yellows": [3, 4, 5, 6, 7, 8, 9, 10, 11],
  "black-vine-weevil": [3, 4, 5],
  "white-pine-weevil": [3, 4, 5, 6, 7],
  "anti-transpirant": [],
  cambistat: [],
  "dormant-oil": [],
  ipm: [],
  "sodium-flush": [],
  "soil-sample": [],
  "stump-treatment": [],
  "tissue-sample": [],
  "water-sample": [],
};

/** The sheet's months for a service (empty = the sheet had none). */
export function sheetMonthsFor(serviceId: string): number[] {
  return SHEET_MONTHS[serviceId] ?? [];
}

/** True when two month sets cover the same months. */
export function sameMonths(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((m) => set.has(m));
}

/**
 * The draft estimate a "Quote it" starts for a PHC service — one $0
 * line (the estimator prices it), status draft. Cultural-only services quote the
 * pruning / assessment work (the method), not a spray. Shared by the
 * morning briefing and the service catalog so both quote identically.
 */
export function buildPhcDraftEstimate(
  service: PhcService,
  customerId: string,
  note: string,
): Estimate {
  const lineText =
    service.kind === "cultural"
      ? `${service.name} — ${service.method} (${service.hosts})`
      : `${service.name} — ${service.treatment} (${service.hosts})`;
  return {
    id: uid(),
    customerId,
    jobId: null,
    title: `${service.name} — PHC treatment`,
    lines: [{ id: uid(), description: lineText, quantity: 1, unitPrice: 0 }],
    taxRate: 0,
    discountType: "none",
    discountValue: 0,
    status: "draft",
    createdDate: todayStr(),
    notes: note,
    emailQueuedAt: null,
    options: null,
    acceptedOptionId: null,
    acceptedBy: null,
    acceptedAt: null,
  };
}

