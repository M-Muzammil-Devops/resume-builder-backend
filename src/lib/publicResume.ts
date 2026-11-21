type HeaderSettings = {
  phone?: boolean;
  link?: boolean;
  email?: boolean;
  location?: boolean;
  extraLink?: boolean;
  extraField?: boolean;
  dateOfBirth?: boolean;
  nationality?: boolean;
};

type HeaderContact = Record<string, unknown>;

const HIDDEN_WHEN_OFF: Array<[keyof HeaderSettings, string[]]> = [
  ["phone", ["phone"]],
  ["email", ["email"]],
  ["location", ["location"]],
  ["link", ["linkedin", "linkedinHref", "website", "github"]],
  ["extraLink", ["extraLink", "extraLinkHref"]],
  ["extraField", ["extraField"]],
  ["dateOfBirth", ["dateOfBirth"]],
  ["nationality", ["nationality"]],
];

function blank(value: unknown): boolean {
  return String(value ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .trim() === "";
}

/** Public share payload: drop fields the owner hid, and drop empty contact values. */
export function redactPublicContent<T>(content: T): T {
  if (!content || typeof content !== "object") return content;
  const copy = structuredClone(content) as {
    sections?: Array<{ type?: string; contact?: HeaderContact; settings?: HeaderSettings }>;
  };
  for (const section of copy.sections || []) {
    if (section.type !== "header" || !section.contact) continue;
    const settings = section.settings || {};
    const offUnlessEnabled = new Set(["extraLink", "extraField", "dateOfBirth", "nationality"]);
    for (const [flag, keys] of HIDDEN_WHEN_OFF) {
      const shown = offUnlessEnabled.has(flag) ? settings[flag] === true : settings[flag] !== false;
      if (!shown) {
        for (const key of keys) delete section.contact[key];
      }
    }
    for (const key of Object.keys(section.contact)) {
      if (blank(section.contact[key])) delete section.contact[key];
    }
  }
  return copy as T;
}
