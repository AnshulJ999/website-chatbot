/** How the inbox and alerts name a visitor who hasn't given a name or email. */
export type VisitorLabel = "number" | "code" | "name";

const ADJECTIVES = ["Amber", "Brave", "Calm", "Clever", "Coral", "Cosmic", "Crimson", "Daring", "Gentle", "Golden", "Happy", "Indigo", "Jolly", "Lucky", "Mellow", "Misty", "Noble", "Olive", "Quiet", "Rapid", "Rosy", "Silver", "Sunny", "Swift", "Teal", "Witty"];
const ANIMALS = ["Badger", "Bear", "Crane", "Dolphin", "Falcon", "Fox", "Gecko", "Hare", "Heron", "Koala", "Lynx", "Moose", "Otter", "Owl", "Panda", "Puffin", "Raven", "Robin", "Seal", "Sparrow", "Tiger", "Turtle", "Whale", "Wolf", "Wren", "Yak"];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A stable two-word name made from the visitor id ("Blue Otter"). */
export function friendlyName(visitorId: string): string {
  const h = hash(visitorId);
  return `${ADJECTIVES[h % ADJECTIVES.length]} ${ANIMALS[Math.floor(h / ADJECTIVES.length) % ANIMALS.length]}`;
}

/** The visitor's display label in the chosen style; falls back to the code when no number is assigned yet. */
export function visitorLabel(style: VisitorLabel, v: { visitorId: string; number?: number | null }): string {
  if (style === "name") return friendlyName(v.visitorId);
  if (style === "number" && v.number) return `Visitor #${v.number}`;
  return `Visitor ${v.visitorId.slice(-4)}`;
}
