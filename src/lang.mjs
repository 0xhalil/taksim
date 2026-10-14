// Product language for user-facing strings: English by default, Türkçe when the
// app asks with `Accept-Language: tr` (the native app sends its language) or ?lang=tr.
// Agent-facing text stays English; only what the person reads is translated.
export const langOf = (req) => {
  try {
    const q = new URL(req.url, "http://x").searchParams.get("lang");
    if (q) return q.startsWith("tr") ? "tr" : "en";
  } catch {}
  return /^\s*tr\b/i.test(String(req.headers?.["accept-language"] || "")) ? "tr" : "en";
};

// T(lang, english, turkish): the string for the person reading the UI.
export const T = (lang, en, tr) => (lang === "tr" ? tr : en);
