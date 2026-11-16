/**
 * Crew field guide — tree knowledge built INTO the app. Nothing here is
 * fetched from another page: every species entry, prune-class
 * definition, cutting rule, and disease sign lives in this file so the
 * crew has it at their fingertips on the job, even offline.
 *
 * Denver sits in USDA hardiness zones 5b–6a. Each species entry gives
 * its own hardiness range; the prune windows are for Denver's climate.
 * The windows encode the crew's working rules — e.g. silver maple is
 * a hard no in June (spring growth flush + heavy sap bleed).
 */

import type { AppState } from "./types";

export const DENVER_ZONE = "USDA zones 5b–6a";

export interface DiseaseEntry {
  name: string;
  /** Photo of the disease/pest (CSU Extension where possible). */
  photoUrl?: string;
  photoCredit?: string;
  /** What it looks like on the tree — the spotter's checklist. */
  signs: string;
  /** What the crew should do (or not do) when they see it. */
  action: string;
}

export interface SpeciesGuide {
  /** Key used to match a tree record's species string. */
  key: string;
  name: string;
  botanical: string;
  /**
   * Photo URL for the species (CSU Extension where possible). Hotlinked —
   * needs internet, like the map tiles. The text stays offline.
   */
  photoUrl?: string;
  /** Who took/published the photo, shown under the zoomed image. */
  photoCredit?: string;
  /** Hardiness range for the species, e.g. "3–9". */
  zones: string;
  /** Mature size / growth habit in a sentence. */
  size: string;
  /** Basic biology the crew should know on site. */
  biology: string[];
  /** Months (1–12) that are the best window to prune. */
  bestMonths: number[];
  /** Why those months are best. */
  bestWhy: string;
  /** Months (1–12) to avoid pruning. */
  avoidMonths: number[];
  /** Why those months are off-limits. */
  avoidWhy: string;
  /**
   * What a Class II (standard) prune means for THIS species — the
   * definition the crew sees when a job is a Class 2 prune.
   */
  classNote: string;
  /** Species-specific cutting guidance. */
  cutNotes: string;
  diseases: DiseaseEntry[];
}

export const SPECIES_GUIDE: SpeciesGuide[] = [
  {
    key: "silver maple",
    name: "Silver maple",
    botanical: "Acer saccharinum",
    photoUrl: "https://planttalk.colostate.edu/images/1733f2.jpg",
    photoCredit: "CSU Extension PlantTalk",
    zones: "3–9",
    size: "Fast grower to 50–70 ft with a wide, spreading crown.",
    biology: [
      "Weak, brittle wood — limbs snap in wind and ice. Check every union before climbing.",
      "Shallow, aggressive roots that lift sidewalks and crowd the lawn.",
      "Heavy sap bleeder: cut in spring and it runs like a tap.",
      "Prone to iron chlorosis (yellow leaves, green veins) in Denver's alkaline soils.",
    ],
    bestMonths: [7, 8, 12, 1, 2],
    bestWhy:
      "Late summer (Jul–Aug) after the spring growth flush has hardened off, or dormant season (Dec–Feb) after leaf drop. Wounds compartmentalize fast and sap flow is low.",
    avoidMonths: [3, 4, 5, 6],
    avoidWhy:
      "Spring and early summer is the bleed window — sap is running hard and fresh cuts weep for weeks. June is the wrong time: the tree is still pushing soft spring growth, so cuts heal slowly and invite decay.",
    classNote:
      "A Class II standard prune on a silver maple means: dead, dying, and diseased wood out first, then crossing and rubbing branches, then weakly attached limbs — especially co-dominant stems with included bark, which this species grows constantly. Thin lightly; never strip the interior.",
    cutNotes:
      "Use reduction cuts back to a lateral at least 1/3 the diameter of the stem. Never top a silver maple — it responds with a flush of weak water sprouts. Three-cut every limb over 2 in so the bark doesn't tear.",
    diseases: [
      {
        name: "Verticillium wilt",
        signs:
          "One side of the crown wilts and dies back while the other side looks fine; streaked brown-green wood under the bark.",
        action:
          "Flag it — do not prune it out and call it fixed. Tell the office; infected trees decline over years and the soil stays infectious.",
      },
      {
        name: "Anthracnose",
        signs:
          "Brown blotches and dead patches on leaves in a wet spring; leaf drop follows, then a second flush of leaves.",
        action:
          "Mostly cosmetic — the tree usually recovers. Clean up fallen leaves; no spray needed on a mature tree.",
      },
      {
        name: "Tar spot",
        signs: "Raised black spots like drops of tar on the leaves.",
        action: "Cosmetic only. Rake and dispose of fallen leaves.",
      },
      {
        name: "Girdling roots",
        signs:
          "Trunk flares into the ground with no root flare visible; the trunk looks like a telephone pole going straight into the soil.",
        action:
          "Note it on the job — girdling roots strangle the tree over time and the office may want a root-collar excavation.",
      },
    ],
  },
  {
    key: "norway maple",
    name: "Norway maple",
    botanical: "Acer platanoides",
    photoUrl: "https://planttalk.colostate.edu/images/1733f3.jpg",
    photoCredit: "CSU Extension PlantTalk",
    zones: "3–7",
    size: "Dense, rounded crown to 40–50 ft. Casts deep shade.",
    biology: [
      "Very shallow roots — almost nothing grows under it, and the lawn thins out.",
      "Girdling roots are common; look for a missing root flare.",
      "Also a sap bleeder in spring, like other maples.",
    ],
    bestMonths: [7, 8, 12, 1, 2],
    bestWhy:
      "Late summer after the growth flush, or dormant season. Sap flow is low and wounds close fast.",
    avoidMonths: [3, 4, 5, 6],
    avoidWhy:
      "Spring and early summer is the bleed window — cuts weep heavily and heal slowly.",
    classNote:
      "Class II on a Norway maple: dead, dying, and diseased wood, crossing and rubbing branches, and weakly attached limbs. Raise the crown for clearance where it overhangs walks and drives — this species holds low limbs.",
    cutNotes:
      "Reduction cuts back to a lateral at least 1/3 the diameter of the stem. Watch for girdling roots at the base and flag them. Never top.",
    diseases: [
      {
        name: "Verticillium wilt",
        signs:
          "One-sided wilting and dieback; streaked wood under the bark.",
        action: "Flag it for the office — it does not prune out.",
      },
      {
        name: "Tar spot",
        signs: "Raised black tar-like spots on leaves.",
        action: "Cosmetic only. Rake fallen leaves.",
      },
      {
        name: "Anthracnose",
        signs: "Brown blotches on leaves in wet springs, followed by leaf drop.",
        action: "Usually recovers on its own. No treatment on a mature tree.",
      },
    ],
  },
  {
    key: "red maple",
    name: "Red maple",
    botanical: "Acer rubrum",
    photoUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/3/36/Acer_rubrum_15-p.bot-a.rubrum-114.jpg/500px-Acer_rubrum_15-p.bot-a.rubrum-114.jpg",
    photoCredit: "Wikimedia Commons",
    zones: "3–9",
    size: "40–60 ft, upright oval crown, brilliant red fall color.",
    biology: [
      "Sap bleeder in spring, like other maples.",
      "Shallow roots; girdling roots show up when it was planted too deep.",
      "Softer wood than sugar maple — limbs break more easily.",
    ],
    bestMonths: [7, 8, 12, 1, 2],
    bestWhy:
      "Late summer after the growth flush, or dormant season. Low sap flow, fast wound closure.",
    avoidMonths: [3, 4, 5, 6],
    avoidWhy:
      "Spring and early summer is the bleed window — fresh cuts weep and heal slowly.",
    classNote:
      "Class II on a red maple: dead, dying, and diseased wood out, crossing and rubbing branches, weakly attached limbs — especially co-dominant leaders with included bark. Thin lightly for structure.",
    cutNotes:
      "Reduction cuts to a lateral at least 1/3 the diameter of the stem. Three-cut limbs over 2 in. Never top.",
    diseases: [
      {
        name: "Verticillium wilt",
        signs: "One-sided wilt and dieback; streaked wood under the bark.",
        action: "Flag it for the office — it does not prune out.",
      },
      {
        name: "Anthracnose",
        signs: "Brown blotches and dead leaf patches in wet springs.",
        action: "Cosmetic in most years; the tree re-leafs.",
      },
      {
        name: "Leaf spot",
        signs: "Small dark spots on leaves, sometimes with yellow halos.",
        action: "Cosmetic. Rake fallen leaves.",
      },
    ],
  },
  {
    key: "honey locust",
    name: "Honey locust",
    botanical: "Gleditsia triacanthos",
    photoUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/9/9d/Gleditsia_triacanthos_(honey_locust)_(Ferris-Wright_Park,_Dublin,_Ohio,_USA)_1_(44582601540).jpg/500px-Gleditsia_triacanthos_(honey_locust)_(Ferris-Wright_Park,_Dublin,_Ohio,_USA)_1_(44582601540).jpg",
    photoCredit: "James St. John / Wikimedia Commons (CC BY)",
    zones: "3–9",
    size: "30–50 ft with a fine, airy canopy that casts dappled shade.",
    biology: [
      "Species trees carry large branched thorns — most yard trees are thornless cultivars ('Shademaster', 'Skycole'). Check before climbing.",
      "Fine leaflets mean light pruning rarely changes the shade much.",
      "Tolerates drought, heat, and poor soil — a tough Denver street tree.",
    ],
    bestMonths: [11, 12, 1, 2, 3],
    bestWhy:
      "Dormant season (late fall through early spring) — the fine branch structure is easy to read with no leaves, and wounds close before growth starts.",
    avoidMonths: [5, 6],
    avoidWhy:
      "Late spring into June is honeylocust plant-bug and webworm season — pruning then stresses the tree while insects are already hammering the new leaves.",
    classNote:
      "Class II standard prune on a honey locust means: dead, dying, and diseased wood out first, then crossing and rubbing branches and weakly attached limbs. Thin lightly — this canopy is already open, so the work is mostly cleaning, not thinning. Keep the natural shape; it rarely needs shaping cuts.",
    cutNotes:
      "Small-diameter cuts heal fast on this species. Watch for thorns on non-cultivar trees — gloves and eye protection. Reduction cuts to a lateral at least 1/3 the diameter of the stem.",
    diseases: [
      {
        name: "Thyronectria canker",
        signs:
          "Sunken, dead patches on branches with clusters of tiny orange-red fruiting bodies; branches die back from the tip.",
        action:
          "Prune infected branches well below the canker into healthy wood. Sterilize tools between cuts. Flag heavy infections for the office.",
      },
      {
        name: "Honeylocust plant bug",
        signs:
          "New leaves in May–June look puckered, yellowed, and stunted; tiny green bugs on the undersides.",
        action:
          "Usually cosmetic and the tree outgrows it. Note it; no spray on a mature tree unless the customer asks.",
      },
      {
        name: "Mimosa webworm",
        signs:
          "Leaves webbed together in silken nests in mid-summer; browned, dead leaflets inside the webbing.",
        action:
          "Prune out small webbed clusters. Flag heavy infestations — the office may schedule a treatment.",
      },
      {
        name: "Spider mites",
        signs:
          "Leaves turn bronze or yellow and look dusty in hot, dry weather; fine webbing on the undersides.",
        action:
          "Note it — mites explode in drought. A hard water spray helps; treatment is the office's call.",
      },
    ],
  },
  {
    key: "black locust",
    name: "Black locust",
    botanical: "Robinia pseudoacacia",
    photoUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/7/76/Robinia_pseudoacacia_-_black_locust_-_Robinie_-_robinier_faux-acacia_01.jpg/500px-Robinia_pseudoacacia_-_black_locust_-_Robinie_-_robinier_faux-acacia_01.jpg",
    photoCredit: "Norbert Nagel / Wikimedia Commons (CC BY-SA)",
    zones: "3–8",
    size: "30–50 ft, narrow crown, very brittle wood.",
    biology: [
      "Extremely brittle — limbs snap without warning. Never trust a dead limb on this species.",
      "Sharp thorns on young branches and suckers.",
      "Sends up root suckers aggressively, especially after root disturbance.",
      "Fixes its own nitrogen, so it grows fast on poor soil.",
    ],
    bestMonths: [11, 12, 1, 2],
    bestWhy:
      "Dormant season only — the structure is visible, and pruning then avoids the locust borer's egg-laying season.",
    avoidMonths: [6, 7, 8, 9],
    avoidWhy:
      "Summer is locust borer season — fresh wounds attract egg-laying adults, and the larvae tunnel the wood the following year.",
    classNote:
      "Class II on a black locust: dead, dying, and diseased wood first — and on this species, dead wood is a safety issue, not cosmetic. Then crossing and rubbing branches and weakly attached limbs. Keep cuts small; big wounds on black locust decay fast.",
    cutNotes:
      "Expect brittle wood — plan rigging for limbs that can fail under their own weight. Three-cut everything over 2 in. Sterilize tools after borer-damaged wood.",
    diseases: [
      {
        name: "Locust borer",
        signs:
          "Sawdust-like frass at branch bases and in bark cracks; branches die back from the tip; swollen, cracked bark over old tunnels.",
        action:
          "Prune out infested branches in the dormant season. Flag heavy infestations — badly bored trees are a removal candidate.",
      },
      {
        name: "Canker",
        signs: "Sunken, dead bark patches on branches and trunk.",
        action:
          "Prune infected wood back into healthy tissue. Sterilize tools between cuts.",
      },
    ],
  },
  {
    key: "green ash",
    name: "Green ash",
    botanical: "Fraxinus pennsylvanica",
    photoUrl: "https://planttalk.colostate.edu/images/1735-fig1.jpg",
    photoCredit: "CSU Extension PlantTalk",
    zones: "3–9",
    size: "50–60 ft, broad oval crown. One of Denver's most common street trees.",
    biology: [
      "Emerald ash borer (EAB) is in the Denver area — every ash is a suspect until proven otherwise.",
      "Opposite branching, diamond-pattern bark, compound leaves.",
      "Seedless cultivars ('Marshall's Seedless', 'Patmore') are common in yards.",
    ],
    bestMonths: [11, 12, 1, 2, 3],
    bestWhy:
      "Dormant season (Nov–Mar) — EAB adults are not flying, so fresh wounds do not attract them, and the crown structure is visible.",
    avoidMonths: [5, 6, 7, 8],
    avoidWhy:
      "May–August is EAB flight season. Pruning wounds in summer release volatiles that draw egg-laying beetles to the tree.",
    classNote:
      "Class II on a green ash: dead, dying, and diseased wood out, crossing and rubbing branches, weakly attached limbs. Check every branch you cut for EAB signs as you go — the cut face tells you what is happening inside.",
    cutNotes:
      "Check for EAB before and during the cut: peel a little bark on suspect limbs and look for S-shaped galleries. Chip or haul EAB wood the same day — do not stockpile ash wood on site.",
    diseases: [
      {
        name: "Emerald ash borer (EAB)",
      photoUrl: "https://extension.colostate.edu/wp-content/uploads/2025/07/eab_threat_urbanforests.jpeg?w=489",
      photoCredit: "CSU Extension",
        signs:
          "D-shaped exit holes about 1/8 in wide; S-shaped galleries under the bark; bark splitting; tufts of sprouts from the trunk (epicormic shoots); crown thinning from the top down; heavy woodpecker activity.",
        action:
          "Stop and tell the office before cutting further — the tree may be a treatment or removal candidate, and ash wood must not be moved or stockpiled. Photograph the signs.",
      },
      {
        name: "Ash rust",
        signs: "Orange powdery spots on leaves in spring.",
        action: "Cosmetic. No treatment on a mature tree.",
      },
      {
        name: "Ash flower gall",
        signs: "Clusters of small green-brown galls where flowers should be.",
        action: "Cosmetic only — the tree looks odd in spring but is unharmed.",
      },
    ],
  },
  {
    key: "white ash",
    name: "White ash",
    botanical: "Fraxinus americana",
    photoUrl: "https://planttalk.colostate.edu/wp-content/uploads/2024/03/1728-Ash-lynne-conroy-scaled.jpeg",
    photoCredit: "CSU Extension PlantTalk",
    zones: "3–9",
    size: "50–80 ft, straight trunk, broad rounded crown.",
    biology: [
      "Emerald ash borer (EAB) is in the Denver area — every ash is a suspect until proven otherwise.",
      "Opposite branching, compound leaves, diamond bark like green ash, but larger at maturity.",
    ],
    bestMonths: [11, 12, 1, 2, 3],
    bestWhy:
      "Dormant season (Nov–Mar) — EAB adults are not flying, so fresh wounds do not attract them.",
    avoidMonths: [5, 6, 7, 8],
    avoidWhy:
      "May–August is EAB flight season. Summer pruning wounds draw egg-laying beetles.",
    classNote:
      "Class II on a white ash: dead, dying, and diseased wood, crossing and rubbing branches, weakly attached limbs. Inspect every cut for EAB galleries as you work.",
    cutNotes:
      "Peel bark on suspect limbs and look for S-shaped galleries. Chip or haul EAB wood the same day — do not stockpile ash wood on site.",
    diseases: [
      {
        name: "Emerald ash borer (EAB)",
      photoUrl: "https://extension.colostate.edu/wp-content/uploads/2025/07/eab_threat_urbanforests.jpeg?w=489",
      photoCredit: "CSU Extension",
        signs:
          "D-shaped exit holes about 1/8 in wide; S-shaped galleries under the bark; bark splitting; epicormic sprouts on the trunk; crown thinning from the top down; heavy woodpecker activity.",
        action:
          "Stop and tell the office before cutting further — treatment or removal decision, and ash wood must not be moved or stockpiled. Photograph the signs.",
      },
      {
        name: "Ash anthracnose",
        signs: "Brown blotches on leaves in wet springs, leaf drop follows.",
        action: "Cosmetic in most years; the tree re-leafs.",
      },
    ],
  },
  {
    key: "blue spruce",
    name: "Blue spruce",
    botanical: "Picea pungens",
    photoUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/df/Picea_pungens_USDA1.jpg/500px-Picea_pungens_USDA1.jpg",
    photoCredit: "USDA Forest Service (public domain)",
    zones: "2–7",
    size: "40–60 ft, dense conical evergreen. Colorado's state tree.",
    biology: [
      "Holds its needles 5–7 years — needle loss on the inner, lower branches is the first sign of trouble.",
      "Very susceptible to needle cast and canker in Denver's dry, hot summers when stressed.",
      "Sharp needles; gloves and eye protection on every cut.",
    ],
    bestMonths: [2, 3, 9, 10],
    bestWhy:
      "Late winter into early spring, before the new growth flush, or early fall. Cuts heal before the growing season and before winter.",
    avoidMonths: [5, 6, 7],
    avoidWhy:
      "Late spring into summer is when Rhizosphaera needle-cast spores spread — fresh cuts and wet new growth invite infection.",
    classNote:
      "Class II on a blue spruce: dead, dying, and diseased branches out — work from the bottom up, since canker and needle cast start low and inside. Crossing and rubbing branches next. Never shear a spruce; keep its natural conical shape.",
    cutNotes:
      "Cut dead branches back to the trunk or to a live lateral — do not leave stubs, they invite canker. Sterilize tools between trees when canker is present. Never top an evergreen.",
    diseases: [
      {
        name: "Cytospora canker",
        signs:
          "White resin flowing from the trunk and branch bases; lower branches die back from the bottom up; brown, crusty cankers on the bark.",
        action:
          "Prune infected branches back to healthy wood. Sterilize tools between cuts. Flag it — canker spreads up the tree over years.",
      },
      {
        name: "Rhizosphaera needle cast",
        signs:
          "Needles turn purple, then brown, and drop — starting on the inner, lower branches and moving up. Tiny black dots (fruiting bodies) in rows on the needles.",
        action:
          "Rake and dispose of fallen needles. Flag it for the office — treatment is a spring fungicide program, not a pruning fix.",
      },
      {
        name: "Spruce spider mite",
        signs:
          "Needles look dusty, yellowed, or bronzed; fine webbing on the undersides in hot, dry weather.",
        action:
          "Note it — a hard water spray knocks numbers down; treatment is the office's call.",
      },
    ],
  },
  {
    key: "ponderosa pine",
    name: "Ponderosa pine",
    botanical: "Pinus ponderosa",
    photoUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d8/Pinus_ponderosa_8144t.jpg/500px-Pinus_ponderosa_8144t.jpg",
    photoCredit: "Wikimedia Commons",
    zones: "3–7",
    size: "50–80 ft, open crown, orange-brown puzzle-piece bark at maturity.",
    biology: [
      "Denver's native foothills pine — drought-tolerant once established.",
      "Drops its oldest (3rd-year) needles every fall — normal, not disease.",
      "Mountain pine beetle is the threat to watch for.",
    ],
    bestMonths: [11, 12, 1, 2, 3],
    bestWhy:
      "Late fall through early spring — beetles are not flying, and the tree is dormant.",
    avoidMonths: [5, 6, 7, 8],
    avoidWhy:
      "Spring through summer is mountain pine beetle flight season. Fresh wounds and the smell of cut pine draw beetles.",
    classNote:
      "Class II on a ponderosa: dead, dying, and diseased branches out, crossing and rubbing branches, weakly attached limbs. Keep the open, airy shape — this species should never look dense or sheared.",
    cutNotes:
      "Cut back to a live lateral or the branch collar; do not leave stubs. Haul or chip cut pine the same day during beetle season. Never top a pine.",
    diseases: [
      {
        name: "Mountain pine beetle",
        signs:
          "Popcorn-sized blobs of pitch (pitch tubes) on the trunk; fine sawdust in bark crevices and at the base; crown fading green to yellow to red, usually starting at the top.",
        action:
          "Stop and tell the office — infested trees usually need removal, and the wood must be handled promptly. Photograph the pitch tubes.",
      },
      {
        name: "Dothistroma needle blight",
        signs:
          "Red-brown bands across the needles, with green tips; lower branches affected first; heavy needle drop.",
        action:
          "Rake and dispose of fallen needles. Flag it — treatment is a spring copper fungicide program.",
      },
      {
        name: "Diplodia tip blight",
        signs:
          "New shoot tips turn brown and stunted, often with resin beads; tiny black dots on the dead needles.",
        action:
          "Prune out blighted tips in dry weather. Sterilize tools between cuts.",
      },
    ],
  },
  {
    key: "austrian pine",
    name: "Austrian pine",
    botanical: "Pinus nigra",
    photoUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/59/%C5%9Awierklaniec_pinus_nigra_12.06.2010_p.jpg/500px-%C5%9Awierklaniec_pinus_nigra_12.06.2010_p.jpg",
    photoCredit: "Wikimedia Commons",
    zones: "4–7",
    size: "40–60 ft, dense dark-green crown.",
    biology: [
      "Planted everywhere in Denver in the 60s–80s, so the crew sees it constantly.",
      "Very prone to Diplodia tip blight here — check every shoot tip.",
      "Tolerates drought and poor soil, but not wet feet.",
    ],
    bestMonths: [11, 12, 1, 2, 3],
    bestWhy:
      "Late fall through early spring — dry weather, dormant tree, lowest disease pressure.",
    avoidMonths: [5, 6, 7],
    avoidWhy:
      "Late spring into summer is peak Diplodia spore season — wet new growth and fresh cuts invite infection.",
    classNote:
      "Class II on an Austrian pine: dead, dying, and diseased branches out — check every tip for blight as you go — then crossing and rubbing branches and weakly attached limbs. Keep the natural shape.",
    cutNotes:
      "Prune blighted tips back into healthy wood, well below the brown. Sterilize tools between cuts — Diplodia rides on blades. Do not prune in wet weather.",
    diseases: [
      {
        name: "Diplodia tip blight",
        signs:
          "New shoots turn brown and stop growing, often with beads of resin; tiny black dots on the dead needles and cones.",
        action:
          "Prune out blighted tips in dry weather. Flag it — heavy infections need a fungicide program from the office.",
      },
      {
        name: "Dothistroma needle blight",
        signs:
          "Red-brown bands across needles; lower branches hit first; needles drop, leaving bare twigs.",
        action: "Rake and dispose of fallen needles. Flag for the office.",
      },
    ],
  },
  {
    key: "cottonwood",
    name: "Cottonwood",
    botanical: "Populus deltoides",
    photoUrl: "https://planttalk.colostate.edu/images/cottonwood-tree.jpg",
    photoCredit: "CSU Extension PlantTalk",
    zones: "2–9",
    size: "Very fast grower to 70–100 ft. The biggest tree on most Denver lots.",
    biology: [
      "Weak, brittle wood — big limbs fail in wind and snow. Treat every large limb as a rigging job.",
      "Massive root system that seeks water — near sewers and foundations.",
      "Drops cottony seed fluff in late spring; heavy leaf drop in fall.",
    ],
    bestMonths: [11, 12, 1, 2],
    bestWhy:
      "Dormant season — the structure is visible, sap flow is low, and there is no seed fluff in the air.",
    avoidMonths: [3, 4, 5],
    avoidWhy:
      "Spring is the bleed window and the start of the seed season — pruning then means weeping cuts and cotton everywhere.",
    classNote:
      "Class II on a cottonwood: dead, dying, and diseased wood first — on this species, dead wood is a safety call — then crossing and rubbing branches and weakly attached limbs. Watch for co-dominant stems with included bark; they are the classic cottonwood failure.",
    cutNotes:
      "Rig large limbs — never free-fall a cottonwood limb, it shatters and the wood is heavy. Three-cut everything over 2 in. Reduction cuts to a lateral at least 1/3 the diameter of the stem.",
    diseases: [
      {
        name: "Cytospora canker",
        signs:
          "Sunken, dead bark patches on branches and trunk, often with orange-tinted bark at the edges.",
        action:
          "Prune infected wood back into healthy tissue. Sterilize tools between cuts. Flag heavy infections.",
      },
      {
        name: "Leaf rust",
        signs: "Orange powdery pustules on the undersides of leaves in summer.",
        action: "Cosmetic. Rake fallen leaves.",
      },
      {
        name: "Poplar borer",
        signs:
          "Swollen, cracked bark at branch bases; sawdust frass; branches die back.",
        action: "Prune out infested branches. Flag heavy infestations.",
      },
    ],
  },
  {
    key: "crabapple",
    name: "Crabapple",
    botanical: "Malus spp.",
    photoUrl: "https://planttalk.colostate.edu/wp-content/uploads/2024/03/1747Flowering-crabapple-Jessica-H-scaled.jpg",
    photoCredit: "CSU Extension PlantTalk",
    zones: "3–8",
    size: "15–25 ft, rounded crown, spring flowers and small fruit.",
    biology: [
      "Ornamental — the customer cares how it looks, so cuts must be clean and the shape kept.",
      "Throws water sprouts (straight vertical shoots) after hard pruning.",
      "Fire blight is the disease that matters — it kills branches fast.",
    ],
    bestMonths: [12, 1, 2, 3],
    bestWhy:
      "Late winter dormant season — structure is visible, fire blight bacteria are inactive, and cuts heal before bloom.",
    avoidMonths: [5, 6, 7],
    avoidWhy:
      "Late spring into summer is fire blight season — bacteria spread fast in warm, wet weather, and fresh cuts are entry points.",
    classNote:
      "Class II on a crabapple: dead, dying, and diseased wood out, crossing and rubbing branches, weakly attached limbs, and water sprouts. Keep the open, rounded shape the customer expects — light thinning, not heavy cutting.",
    cutNotes:
      "Sterilize tools between EVERY cut when fire blight is suspected — dip in alcohol or a 10% bleach solution. Cut blighted wood 8–12 in below the visible damage into healthy wood. Never prune in wet weather.",
    diseases: [
      {
        name: "Fire blight",
        signs:
          "Shoot tips bend over like a shepherd's crook and turn black, as if burned; dead leaves hang on the branch; amber ooze on the bark in wet weather.",
        action:
          "Sterilize tools between every cut. Cut 8–12 in below the damage into healthy wood. Bag the cuttings — do not chip blighted wood on site. Tell the office the same day.",
      },
      {
        name: "Apple scab",
        signs:
          "Olive-green to black spots on leaves, yellowing, and early leaf drop; fruit is cracked and scabby.",
        action:
          "Cosmetic on most trees. Rake and dispose of fallen leaves — the fungus overwinters in them.",
      },
      {
        name: "Cedar-apple rust",
        signs:
          "Bright orange spots on the leaves in spring; orange jelly-like horns on nearby junipers.",
        action:
          "Cosmetic. No treatment on a mature tree unless the customer asks.",
      },
    ],
  },
  {
    key: "bur oak",
    name: "Bur oak",
    botanical: "Quercus macrocarpa",
    photoUrl: "https://planttalk.colostate.edu/images/1736f2.jpg",
    photoCredit: "CSU Extension PlantTalk",
    zones: "3–8",
    size: "50–70 ft, massive spreading crown. Denver's hardiest oak.",
    biology: [
      "Very strong wood — one of the safest trees to climb.",
      "Oak wilt is the disease that changes how we prune: no pruning in the risk window.",
      "Deep roots; tolerates drought once established.",
    ],
    bestMonths: [11, 12, 1, 2, 3],
    bestWhy:
      "Dormant season (Nov–Mar) — oak wilt beetles are not active, and the structure is visible.",
    avoidMonths: [4, 5, 6, 7, 8, 9, 10],
    avoidWhy:
      "Mid-April through mid-October is oak wilt season. Sap beetles carry the fungus from infected trees to fresh wounds within minutes. Any wound in this window must be painted immediately — this is the one exception to the no-paint rule.",
    classNote:
      "Class II on a bur oak: dead, dying, and diseased wood out, crossing and rubbing branches, weakly attached limbs. Oaks compartmentalize well — clean collar cuts, no stubs. Keep the strong central leader.",
    cutNotes:
      "If you must cut an oak between April and October, paint the wound immediately with pruning paint or latex paint — oak wilt spreads through fresh wounds. Otherwise, never paint wounds. Reduction cuts to a lateral at least 1/3 the diameter of the stem.",
    diseases: [
      {
        name: "Oak wilt",
        signs:
          "Leaves wilt and turn brown from the edges inward, often one branch or one side first; rapid decline over weeks in red oaks, slower in bur oak; dark streaks under the bark.",
        action:
          "Stop and tell the office immediately — oak wilt is a reportable concern and the tree may need removal. Do not move oak wood. Paint any fresh wound on the spot.",
      },
      {
        name: "Bur oak blight",
        signs:
          "Brown veins and dead patches along the leaf veins in late summer; leaves hang on into fall.",
        action:
          "Mostly cosmetic. Rake fallen leaves. Flag it if the crown is thinning year over year.",
      },
      {
        name: "Oak galls",
        signs: "Round balls or lumps on leaves, twigs, or buds.",
        action: "Cosmetic. No treatment.",
      },
    ],
  },
  {
    key: "hackberry",
    name: "Hackberry",
    botanical: "Celtis occidentalis",
    photoUrl: "https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d0/Celtis_occidentalis_15-p.bot-celtis.occi-02.jpg/500px-Celtis_occidentalis_15-p.bot-celtis.occi-02.jpg",
    photoCredit: "Chhe / Wikimedia Commons (public domain)",
    zones: "2–9",
    size: "40–60 ft, broad crown, warty gray bark.",
    biology: [
      "One of the toughest trees in Denver — drought, heat, poor soil, and wind.",
      "Warty bark and nipple galls on the leaves look alarming but are harmless.",
      "Good shade tree with strong wood.",
    ],
    bestMonths: [11, 12, 1, 2, 3],
    bestWhy: "Dormant season — structure is visible and wounds close before growth.",
    avoidMonths: [5, 6],
    avoidWhy:
      "Late spring is peak aphid and psyllid season — pruning then stresses the tree while insects are already feeding.",
    classNote:
      "Class II on a hackberry: dead, dying, and diseased wood out, crossing and rubbing branches, weakly attached limbs. This species holds its shape well — the work is mostly cleaning.",
    cutNotes:
      "Clean collar cuts; this species compartmentalizes well. Three-cut limbs over 2 in. Never top.",
    diseases: [
      {
        name: "Nipple gall",
        signs: "Small raised bumps on the undersides of leaves.",
        action: "Cosmetic — caused by tiny psyllid insects. No treatment.",
      },
      {
        name: "Witches' broom",
        signs: "Dense clusters of twiggy growth, like a broom, on branch tips.",
        action:
          "Cosmetic in most cases. Prune out heavy clusters if the customer asks.",
      },
      {
        name: "Woolly hackberry aphid",
        signs: "White, woolly clusters on leaves; sticky honeydew on everything below; sooty black mold on the honeydew.",
        action:
          "Note it — messy but rarely harms the tree. Treatment is the office's call.",
      },
    ],
  },
  {
    key: "linden",
    name: "Littleleaf linden",
    botanical: "Tilia cordata",
    photoUrl: "https://planttalk.colostate.edu/wp-content/uploads/2024/02/1734Linden-Jill-Fielder-scaled.jpg",
    photoCredit: "CSU Extension PlantTalk",
    zones: "3–7",
    size: "40–60 ft, neat pyramidal crown, fragrant summer flowers.",
    biology: [
      "Aphids love it — expect sticky honeydew and sooty mold under the canopy in summer.",
      "Japanese beetles skeletonize the leaves in July.",
      "Strong wood, good structure, a reliable street tree.",
    ],
    bestMonths: [11, 12, 1, 2, 3],
    bestWhy: "Dormant season — structure is visible, and there are no aphids or beetles to spread.",
    avoidMonths: [6, 7],
    avoidWhy:
      "June–July is Japanese beetle and aphid season — pruning then adds stress while insects are already feeding hard.",
    classNote:
      "Class II on a linden: dead, dying, and diseased wood out, crossing and rubbing branches, weakly attached limbs. Keep the pyramidal shape — light thinning, and raise the crown for street clearance where needed.",
    cutNotes:
      "Clean collar cuts. Watch for co-dominant stems with included bark at the top — a common linden defect. Three-cut limbs over 2 in.",
    diseases: [
      {
        name: "Aphids and sooty mold",
        signs:
          "Sticky honeydew coating leaves, cars, and patios under the tree; black sooty mold growing on the honeydew.",
        action:
          "Note it — messy for the customer but rarely harms the tree. Treatment is the office's call.",
      },
      {
        name: "Japanese beetles",
        signs:
          "Leaves skeletonized to lace in July; beetles clustered on the foliage.",
        action:
          "Note the severity. Heavy years can defoliate a young tree — flag it for the office.",
      },
      {
        name: "Canker",
        signs: "Sunken, dead bark patches on branches.",
        action: "Prune infected wood back into healthy tissue. Sterilize tools.",
      },
    ],
  },
  {
    key: "aspen",
    name: "Aspen",
    botanical: "Populus tremuloides",
    photoUrl: "https://planttalk.colostate.edu/images/aspen-trees.jpg",
    photoCredit: "CSU Extension PlantTalk",
    zones: "1–6",
    size: "30–50 ft, narrow crown, white bark, fluttering leaves.",
    biology: [
      "Short-lived in Denver — heat and drought stress it, and it declines fast once stressed.",
      "Clonal: one root system can send up dozens of stems.",
      "Thin bark sunscalds easily on the south and west sides.",
    ],
    bestMonths: [11, 12, 1, 2],
    bestWhy: "Dormant season — the tree is least stressed and canker spores are least active.",
    avoidMonths: [4, 5, 6, 7, 8],
    avoidWhy:
      "Spring through summer is Cytospora canker season — fresh wounds in warm, wet weather invite infection, and a stressed aspen cannot fight it off.",
    classNote:
      "Class II on an aspen: dead, dying, and diseased wood out first — on a declining aspen that can be most of the crown — then crossing and rubbing branches and weakly attached limbs. Keep cuts small and few; every cut is a canker entry point on this species.",
    cutNotes:
      "Do not over-prune an aspen — stress invites canker. Prune only in the dormant season, in dry weather. Sterilize tools between cuts when canker is present.",
    diseases: [
      {
        name: "Cytospora canker",
        signs:
          "Sunken, orange-brown cankers with blackened bark on branches and trunk; branches die back from the tip.",
        action:
          "Prune infected wood back into healthy tissue in the dormant season. Flag declining trees — canker is often the beginning of the end for a Denver aspen.",
      },
      {
        name: "Bronze leaf disease",
        signs:
          "Leaves turn brown-bronze in late summer and hang on; branches die back over the following years.",
        action: "Flag it for the office — there is no cure, and infected trees decline.",
      },
      {
        name: "Leaf spot",
        signs: "Dark spots on leaves in wet springs.",
        action: "Cosmetic. Rake fallen leaves.",
      },
    ],
  },
];

/** ANSI A300 prune classes — what each class means on the job. */
export interface PruneClass {
  id: "1" | "2" | "3" | "4";
  name: string;
  definition: string;
  typicalUse: string;
}

export const PRUNE_CLASSES: PruneClass[] = [
  {
    id: "1",
    name: "Class I — Fine pruning",
    definition:
      "Selective removal of dead, dying, diseased, crossing, and weakly attached branches, plus small live branches to improve structure and appearance. Light, detailed work — mostly hand pruners and small saws.",
    typicalUse:
      "High-visibility ornamental trees, young trees being trained, and trees the customer looks at every day.",
  },
  {
    id: "2",
    name: "Class II — Standard pruning",
    definition:
      "Everything in Class I, plus thinning of live branches to improve structure and let light and air into the crown. This is the standard maintenance prune — the class most residential jobs are.",
    typicalUse:
      "The default for a routine prune: clean the dead wood, fix crossings and weak unions, thin lightly, keep the natural shape.",
  },
  {
    id: "3",
    name: "Class III — Hazard pruning",
    definition:
      "Remove dead, diseased, broken, and weakly attached branches that pose a hazard to people or property. Safety first — appearance comes second. The tree may still look rough when you are done.",
    typicalUse:
      "Storm damage, dead limbs over a roof, driveway, or walkway, and any tree the office flagged as a risk.",
  },
  {
    id: "4",
    name: "Class IV — Crown reduction",
    definition:
      "Reduce the height and spread of the crown by cutting back to laterals at least one-third the diameter of the stem being removed. This is NOT topping — topping (cutting to stubs with no lateral) is never acceptable.",
    typicalUse:
      "Clearance from a roof, lines, or structure, or reducing a storm-damaged crown. Only when the office specifies it.",
  },
];

/** Cutting fundamentals every crew member should know. */
export const CUTTING_BASICS: Array<{ title: string; body: string }> = [
  {
    title: "The three-cut method",
    body: "For any limb over 2 inches: 1) undercut 12–18 inches out from the trunk, a third of the way through; 2) top cut a few inches further out until the limb drops; 3) final cut just outside the branch collar. Never let a limb tear the bark on its way down.",
  },
  {
    title: "Cut at the collar, never flush",
    body: "Find the swollen ring where the branch meets the trunk — the branch collar — and cut just outside it. A flush cut removes the tree's own wound-closing tissue and leaves a wound that never heals right. Never leave a stub either.",
  },
  {
    title: "Reduction cuts, not heading cuts",
    body: "When shortening a limb, cut back to a lateral branch at least one-third the diameter of the stem you are removing. Cutting to a stub (heading) forces a flush of weak water sprouts.",
  },
  {
    title: "Never top a tree",
    body: "Topping — cutting the crown back to stubs — starves the tree, invites decay, and produces weak, fast-growing sprouts that break in the next storm. If a customer asks for topping, the answer is a crown reduction (Class IV) or a removal.",
  },
  {
    title: "No wound paint — except oaks in season",
    body: "Do not paint or seal pruning wounds; the tree compartmentalizes on its own, and paint traps moisture. The one exception: oaks pruned between mid-April and mid-October — paint the wound immediately to block oak wilt beetles.",
  },
  {
    title: "No more than a quarter of the live crown",
    body: "Never remove more than 25% of the live crown in one season. A tree that loses too much foliage at once cannot feed itself and throws stress sprouts.",
  },
  {
    title: "Sterilize when disease is on the tree",
    body: "Fire blight, oak wilt, canker, and Diplodia all ride on blades. Dip tools in alcohol or a 10% bleach solution between cuts when disease is suspected — and between trees, not just between jobs.",
  },
  {
    title: "Check the union before you climb it",
    body: "Co-dominant stems with included bark, dead limbs over the work zone, and cracked unions are the failures that hurt people. Look up, sound the wood, and rig anything you do not trust.",
  },
];

export type PruneVerdict = "good" | "ok" | "wrong";

/** Find the guide entry for a tree record's species string (fuzzy, case-insensitive). */
export function findSpeciesGuide(species: string): SpeciesGuide | null {
  const s = species.toLowerCase();
  if (!s.trim()) return null;
  return (
    SPECIES_GUIDE.find(
      (g) =>
        s.includes(g.key) ||
        g.key
          .split(" ")
          .every((w) => s.includes(w)),
    ) ?? null
  );
}

/**
 * Every species the guide lists: the 16 curated reference entries
 * PLUS any other species that shows up in the team's actual work.
 * `guide` is null for a species found in the work that has no curated
 * entry yet — the page shows it as a basic entry instead.
 */
export interface SpeciesInUse {
  /** Guide key for a curated entry, `raw:<normalized>` for a basic one. */
  key: string;
  /** Display name (title-cased for a basic entry). */
  name: string;
  botanical?: string;
  /** Null when the species has no curated entry yet. */
  guide: SpeciesGuide | null;
  /** Distinct customer trees with this species. */
  trees: number;
  /** Distinct estimates that mention this species. */
  estimates: number;
}

function titleCaseSpecies(raw: string): string {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Derive the guide's species list from the team's actual work.
 *
 * Sources, in order:
 * (a) customer trees' `species` values — a value that resolves to a
 *     guide key (via findSpeciesGuide) counts toward that curated
 *     entry; a value that does not resolve becomes a basic entry.
 *     Job-linked trees are the same Tree records, so (b) adds no
 *     distinct species beyond (a) — a tree's species is counted once
 *     no matter how many jobs link it.
 * (c) estimate line descriptions (including proposal-option lines)
 *     that resolve to a guide key, and lines linked to a tree
 *     (treeId) whose species resolves — each estimate counts once
 *     per species, however many lines mention it.
 *
 * Free text is never invented into a species: descriptions only ever
 * contribute a guide-key match, and a basic entry only ever comes
 * from a real Tree.species value. Blank species are skipped.
 * The 16 curated entries are always present, even with zero counts —
 * the guide gains species, it never loses the reference set.
 * Pass null (e.g. while state is loading) for the curated 16 only.
 */
export function speciesInUse(
  state: Pick<AppState, "trees" | "estimates"> | null,
): SpeciesInUse[] {
  const byKey = new Map<string, SpeciesInUse>();
  for (const g of SPECIES_GUIDE) {
    byKey.set(g.key, {
      key: g.key,
      name: g.name,
      botanical: g.botanical,
      guide: g,
      trees: 0,
      estimates: 0,
    });
  }
  const raw = new Map<string, SpeciesInUse>();
  const treeById = new Map<string, string>();
  if (state) {
    for (const t of state.trees) treeById.set(t.id, t.species ?? "");
    for (const t of state.trees) {
      const value = (t.species ?? "").trim();
      if (!value) continue;
      const g = findSpeciesGuide(value);
      if (g) {
        byKey.get(g.key)!.trees += 1;
      } else {
        const n = value.toLowerCase();
        const entry = raw.get(n) ?? {
          key: `raw:${n}`,
          name: titleCaseSpecies(value),
          guide: null,
          trees: 0,
          estimates: 0,
        };
        entry.trees += 1;
        raw.set(n, entry);
      }
    }
    for (const est of state.estimates) {
      const hitKeys = new Set<string>();
      const descs: string[] = est.lines.map((l) => l.description);
      for (const o of est.options ?? []) {
        descs.push(...o.lines.map((l) => l.description));
      }
      for (const d of descs) {
        const g = findSpeciesGuide(d);
        if (g) hitKeys.add(g.key);
      }
      const lineTrees: string[] = est.lines
        .map((l) => l.treeId)
        .filter((id): id is string => !!id);
      for (const o of est.options ?? []) {
        lineTrees.push(
          ...o.lines
            .map((l) => l.treeId)
            .filter((id): id is string => !!id),
        );
      }
      for (const id of lineTrees) {
        const value = (treeById.get(id) ?? "").trim();
        if (!value) continue;
        const g = findSpeciesGuide(value);
        hitKeys.add(g ? g.key : `raw:${value.toLowerCase()}`);
      }
      for (const key of hitKeys) {
        const entry = byKey.get(key) ?? raw.get(key.slice(4));
        if (entry) entry.estimates += 1;
      }
    }
  }
  return [
    ...byKey.values(),
    ...[...raw.values()].sort((a, b) => a.name.localeCompare(b.name)),
  ];
}

/** Where a species shows up in the work, e.g. "On 3 customer trees · In 2 estimates". */
export function formatSpeciesWhere(entry: SpeciesInUse): string {
  const parts: string[] = [];
  if (entry.trees > 0) {
    parts.push(
      `On ${entry.trees} customer tree${entry.trees === 1 ? "" : "s"}`,
    );
  }
  if (entry.estimates > 0) {
    parts.push(
      `In ${entry.estimates} estimate${entry.estimates === 1 ? "" : "s"}`,
    );
  }
  return parts.join(" · ");
}

/**
 * Prune-window verdict for a species in a given month (1–12).
 * "wrong" = this month is in the avoid window (e.g. silver maple in June).
 */
export function pruneVerdict(
  guide: SpeciesGuide,
  month: number,
): { verdict: PruneVerdict; note: string } {
  if (guide.avoidMonths.includes(month))
    return { verdict: "wrong", note: guide.avoidWhy };
  if (guide.bestMonths.includes(month))
    return { verdict: "good", note: guide.bestWhy };
  return {
    verdict: "ok",
    note: "Not the best window and not a hard no — the tree will tolerate it, but the best months are better.",
  };
}

export function pruneClassById(
  id: "1" | "2" | "3" | "4",
): PruneClass | undefined {
  return PRUNE_CLASSES.find((c) => c.id === id);
}

export function monthName(month: number): string {
  return new Date(2000, month - 1, 1).toLocaleDateString("en-US", {
    month: "long",
  });
}

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Compact month list, e.g. [7, 8, 12, 1, 2] → "Jul–Aug, Dec–Feb". */
export function formatMonths(months: number[]): string {
  const sorted = [...months].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const m = sorted[i];
    if (m === prev + 1) {
      prev = m;
      continue;
    }
    ranges.push(
      start === prev
        ? SHORT_MONTHS[start - 1]
        : `${SHORT_MONTHS[start - 1]}–${SHORT_MONTHS[prev - 1]}`,
    );
    start = m;
    prev = m;
  }
  return ranges.join(", ");
}
