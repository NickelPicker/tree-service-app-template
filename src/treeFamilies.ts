/**
 * Tree families for the Plant Health Care catalog (business rule:
 * "organized by family of tree that is affected"). Each family lists
 * the common trees that belong to it; a catalog service shows under
 * every family its hosts belong to. Hosts that name no particular tree
 * ("Everything", "Stressed plants") go under "Many kinds of trees".
 */
export interface TreeFamily {
  id: string;
  /** Plain name, e.g. "Pine family". */
  name: string;
  /** Botanical family name. */
  botanical: string;
  /** Common trees in this family (shown under the heading). */
  trees: string;
}

export const TREE_FAMILIES: TreeFamily[] = [
  { id: "pine", name: "Pine family", botanical: "Pinaceae", trees: "pine, spruce, fir, Douglas-fir" },
  { id: "cypress", name: "Cypress family", botanical: "Cupressaceae", trees: "juniper, cedar, arborvitae" },
  { id: "rose", name: "Rose family", botanical: "Rosaceae", trees: "apple, crabapple, pear, cherry, plum, peach, hawthorn, mountain ash" },
  { id: "willow", name: "Willow family", botanical: "Salicaceae", trees: "aspen, cottonwood, poplar, willow" },
  { id: "olive", name: "Olive family", botanical: "Oleaceae", trees: "ash, lilac" },
  { id: "elm", name: "Elm family", botanical: "Ulmaceae", trees: "American elm, Siberian elm" },
  { id: "soapberry", name: "Maple family", botanical: "Sapindaceae", trees: "maple, boxelder, horsechestnut" },
  { id: "beech", name: "Oak family", botanical: "Fagaceae", trees: "oak (red, English, scrub)" },
  { id: "birch", name: "Birch family", botanical: "Betulaceae", trees: "birch" },
  { id: "pea", name: "Pea family", botanical: "Fabaceae", trees: "honeylocust, black locust" },
  { id: "walnut", name: "Walnut family", botanical: "Juglandaceae", trees: "walnut" },
  { id: "plane", name: "Sycamore family", botanical: "Platanaceae", trees: "sycamore" },
  { id: "heath", name: "Heath family", botanical: "Ericaceae", trees: "rhododendron" },
  { id: "general", name: "Many kinds of trees", botanical: "", trees: "general care, stress, any tree" },
];

/** Word rules, checked in order (mountain ash is a rose, not an ash). */
const RULES: Array<[RegExp, string]> = [
  [/\bmountain ash\b/, "rose"],
  [/\b(crab)?apples?\b|\bpears?\b|\bcherr(y|ies)\b|\bplums?\b|\bpeach(es)?\b|\bhawthorns?\b|\bfruit trees?\b/, "rose"],
  [/\bpines?\b|\bspruces?\b|\bfirs?\b|\bdouglas-fir\b/, "pine"],
  [/\bjunipers?\b|\bcedars?\b|\barborvitae\b/, "cypress"],
  [/\baspens?\b|\bcottonwoods?\b|\bpoplars?\b|\bwillows?\b/, "willow"],
  [/\bash\b|\blilacs?\b/, "olive"],
  [/\belms?\b/, "elm"],
  [/\bmaples?\b|\bboxelders?\b|\bhorsechestnuts?\b/, "soapberry"],
  [/\boaks?\b/, "beech"],
  [/\bbirch(es)?\b/, "birch"],
  [/\blocusts?\b/, "pea"],
  [/\bwalnuts?\b/, "walnut"],
  [/\bsycamores?\b/, "plane"],
  [/\brhododendrons?\b/, "heath"],
];

/** Family ids for a catalog "hosts" text such as "Aspen, cottonwood, maple, willow". */
export function familiesForHosts(hosts: string): string[] {
  const out = new Set<string>();
  for (const raw of hosts.split(",")) {
    const part = raw.trim().toLowerCase();
    if (!part) continue;
    const hit = RULES.find(([re]) => re.test(part));
    out.add(hit ? hit[1] : "general");
  }
  if (out.size === 0) out.add("general");
  return TREE_FAMILIES.map((f) => f.id).filter((id) => out.has(id));
}
