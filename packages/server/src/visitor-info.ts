/** "Mobile / Chrome / Android / en", from the browser's user agent and language. */
export function deviceLine(ua: string, lang?: string): string {
  const type = /mobile|android|iphone|ipad|ipod/i.test(ua) ? "Mobile" : "Desktop";
  let browser = "Unknown";
  if (/edg\//i.test(ua)) browser = "Edge";
  else if (/firefox\//i.test(ua)) browser = "Firefox";
  else if (/chrome\//i.test(ua) && !/chromium/i.test(ua)) browser = "Chrome";
  else if (/safari\//i.test(ua)) browser = "Safari";
  let os = "Unknown";
  if (/windows/i.test(ua)) os = "Windows";
  else if (/android/i.test(ua)) os = "Android";
  else if (/iphone|ipad|ipod/i.test(ua)) os = "iOS";
  else if (/mac os x|macintosh/i.test(ua)) os = "macOS";
  else if (/cros/i.test(ua)) os = "ChromeOS";
  else if (/linux/i.test(ua)) os = "Linux";
  return [type, browser, os, lang?.split(/[,;]/)[0]?.trim()].filter(Boolean).join(" / ").slice(0, 120);
}

/** "Direct" for none and for the site's own pages, else "Referral (host)". */
export function referrerLine(raw: string | undefined, ownOrigins: string[]): string {
  if (!raw) return "Direct";
  try {
    const host = new URL(raw).hostname.replace(/^www\./, "");
    const own = ownOrigins.map((o) => {
      try {
        return new URL(o).hostname.replace(/^www\./, "");
      } catch {
        return "";
      }
    });
    if (own.includes(host) || host === "localhost" || host === "127.0.0.1") return "Direct";
    return `Referral (${host})`;
  } catch {
    return raw.slice(0, 120);
  }
}

/** "City, Region, Country", leaving out a region that repeats the city. */
export function placeLine(p: { city?: string; region?: string; country?: string }): string {
  const region = p.region && p.region !== p.city ? p.region : undefined;
  return [p.city, region, p.country].filter(Boolean).join(", ") || "Unknown location";
}
