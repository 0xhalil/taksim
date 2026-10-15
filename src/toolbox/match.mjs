// Which saved tools fit a message. Small and local on purpose: it runs on every message an agent gets, so
// no model call. A tool is described by the phrases a person would say when they need it ("when", written by
// the agent that made it), keywords, its name and summary, the programs it runs, and phrases learned from
// the messages that led to it being used. Turkish suffixes ("pod'larını", "kubernetes'e") are handled by
// prefix matching, and a few aliases join words people use for the same thing (k8s, kubectl, kubernetes).

const STOP = new Set(("a an and are as at be bu bir bunu şu şunu ve ile için icin de da mi mı mu mü ne nasıl nasil "
  + "the to of in on for is it this that me my bana beni benim şimdi simdi lütfen lutfen please can could you "
  + "olan olarak gibi daha çok cok var yok ama fakat ki ya veya or with from by bak bakar bakabilir misin neden niye why "
  + "et yap yapar göster goster show ajan agent oluştur olustur create kur "
  // greetings and thanks say nothing about what is needed
  + "selam selamlar merhaba merhabalar hello hi hey hola günaydın gunaydin teşekkürler tesekkurler teşekkür tesekkur sağol sagol thanks thank "
  // what's left of a word after an apostrophe: kubernetes'e, pod'ları, app.log'daki
  + "lar ler ları leri in ın un ün nin nın nun nün den dan ten tan de da te ta ye ya yi yı yu yü si sı su sü li lı lu lü "
  + "daki deki taki teki nda nde ndaki ndeki").split(" ").map((w) => w.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i")));

const ALIASES = [
  ["k8s", "kubernetes", "kubectl", "kube", "cluster", "küme", "pod", "deployment", "namespace"],
  ["docker", "container", "konteyner", "compose", "image"],
  ["postgres", "postgresql", "psql", "pg"],
  ["db", "database", "veritabanı", "sql"],
  ["log", "logs", "günlük", "tail", "journal"],
  ["cpu", "işlemci", "load", "yük"],
  ["mem", "memory", "bellek", "ram"],
  ["disk", "storage", "depolama", "df"],
  ["process", "süreç", "proses", "ps"],
  ["ci", "pipeline", "build", "derleme", "workflow"],
  ["git", "commit", "branch", "dal"],
  ["test", "tests", "testler", "pytest", "jest"],
  ["error", "hata", "exception", "fail", "crash", "çöküyor", "çöktü", "çökme"],
  ["watch", "izle", "takip", "monitor", "gözle"],
  ["http", "endpoint", "api", "url", "health"],
];

// lower case, Turkish-aware, accents folded (ı→i, ş→s, …) so "Günlük" and "gunluk" meet
export function fold(s) {
  return String(s ?? "").toLocaleLowerCase("tr").replace(/ı/g, "i").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function tokens(s) {
  return fold(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t) && !/^\d+$/.test(t));
}

const ALIAS_OF = new Map();
for (const group of ALIASES) {
  const g = group.map(fold);
  for (const w of g) ALIAS_OF.set(w, g);
}
function aliasesOf(t) {
  for (const [w, g] of ALIAS_OF) if (w === t || (w.length >= 3 && similar(w, t) >= 0.8)) return g;
  return null;
}

// 1 for the same word, 0.8 when one is the other plus a suffix (pod / podlari, izle / izliyor), else 0
export function similar(a, b) {
  if (a === b) return 1;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 3 && l.startsWith(s)) return 0.8;
  let p = 0;
  while (p < s.length && s[p] === l[p]) p++;
  return p >= 4 && p >= s.length * 0.7 ? 0.8 : 0;
}

const W = { when: 3, keywords: 3, bins: 3, name: 2.5, learned: 2, summary: 1.5, commands: 1, instructions: 0.5 };

// Every word a tool is known by, with the weight of the field it came from (the highest one wins).
function termsOf(tool) {
  const t = new Map();
  const add = (text, w) => { for (const k of tokens(text)) if ((t.get(k) || 0) < w) t.set(k, w); };
  for (const p of tool.when || []) add(p, W.when);
  for (const k of tool.keywords || []) add(k, W.keywords);
  for (const b of tool.requires?.bin || []) add(b, W.bins);
  add(tool.name, W.name);
  add(tool.id?.replace(/-/g, " "), W.name);
  for (const p of tool.learned || []) add(p, W.learned);
  add(tool.summary, W.summary);
  for (const s of Object.values(tool.spec?.sources || {})) if (Array.isArray(s.run)) add(s.run.filter((a) => !a.startsWith("-")).slice(0, 3).join(" "), W.commands);
  add(String(tool.instructions || "").slice(0, 600), W.instructions);
  return t;
}

// The words a tool is *about*: its keywords, the programs it runs, its name. A message that uses one of them
// (or the word plus a suffix: "podlarına" for "pod") names the tool's subject.
function subjectOf(tool) {
  const s = new Set();
  // a keyword of several words ("pull request") is one subject: "request" alone doesn't name it
  for (const text of [...(tool.keywords || []), ...(tool.requires?.bin || [])]) { const k = tokens(text); if (k.length === 1) s.add(k[0]); }
  for (const k of tokens(`${tool.name} ${tool.id?.replace(/-/g, " ")}`)) s.add(k);
  return s;
}
// the word itself, or with a suffix: any after a stem of four letters ("diskte"), a plural after a shorter one
// ("podlarına", "logs"), so "login" doesn't name "log" and "running" doesn't name "run"
// words every coding request is full of: a tool may list them, but they don't say the message is about it
const GENERIC = new Set("test tests run runs build file files change changes request error errors user code task plan check start open".split(" "));
const names = (w, k) => !GENERIC.has(w) && (w === k || (w.startsWith(k) && (k.length >= 4 || (k.length === 3 && /^(lar|ler|s$|es$)/.test(w.slice(3))))));

// Score every tool for a query; best first, zero scores dropped. Each hit carries the words that matched,
// how many of the message's words name the tool's subject (`subject`) and whether the message repeats one of
// the phrases the tool was written for (`phrase`).
export function rank(query, tools) {
  const q = [...new Set(tokens(query))];
  if (!q.length || !tools.length) return [];
  const docs = tools.map((tool) => ({ tool, terms: termsOf(tool), about: subjectOf(tool) }));
  // a word most tools share (e.g. "watch") says little; a rare one ("kubectl") says a lot
  const df = (word) => docs.filter((d) => [...d.terms.keys()].some((k) => similar(word, k))).length;
  const idf = new Map(q.map((w) => [w, Math.log(1 + (docs.length + 1) / (df(w) + 0.5))]));

  const out = [];
  for (const { tool, terms, about } of docs) {
    let score = 0, hits = 0, phrase = false;
    const why = [];
    const subject = q.filter((w) => [...about].some((k) => names(w, k)) || (!GENERIC.has(w) && (ALIAS_OF.get(w) || []).some((a) => about.has(a)))).length;
    for (const w of q) {
      let best = 0, hit = null;
      for (const [k, weight] of terms) {
        const s = similar(w, k) * weight;
        if (s > best) { best = s; hit = k; }
      }
      // an alias ("k8s" for a tool that says "kubectl") counts a little less than the word itself
      if (best < W.keywords * 0.8) {
        const g = aliasesOf(w);
        for (const a of g || []) {
          const s = (terms.get(a) || 0) * 0.5;
          if (s > best) { best = s; hit = a; }
        }
      }
      if (best > 0) { score += best * idf.get(w); why.push(hit); hits++; }
    }
    if (!score) continue;
    // a "when" phrase the message mostly repeats is the strongest sign there is
    for (const [i, p] of [...(tool.when || []), ...(tool.learned || [])].entries()) {
      const pt = tokens(p);
      if (!pt.length) continue;
      const covered = pt.filter((x) => q.some((w) => similar(w, x))).length / pt.length;
      if (covered >= (pt.length === 1 ? 1 : 0.6)) { score += 4 * covered; phrase = i < (tool.when || []).length && (pt.length >= 2 || subject >= 1); break; }
    }
    // ...and a "not_when" phrase it repeats vetoes the tool outright: a lookalike
    // need must never open it, however well the other words match
    let vetoed = false;
    for (const p of tool.not_when || []) {
      const pt = tokens(p);
      if (!pt.length) continue;
      const covered = pt.filter((x) => q.some((w) => similar(w, x))).length / pt.length;
      if (covered >= (pt.length === 1 ? 1 : 0.6)) { vetoed = true; break; }
    }
    if (vetoed || score <= 0) continue;
    score = score / Math.sqrt(Math.max(2, why.length + (q.length - why.length) / 2)) + Math.log1p(tool.uses || 0) * 0.25;
    out.push({ tool, score: Math.round(score * 100) / 100, why: [...new Set(why)], hits, subject, phrase });
  }
  return out.sort((a, b) => b.score - a.score);
}

export const HINT_SCORE = 3.5; // a tool above this is named to the agent with the message

// The tools worth naming along with a message: clearly relevant, and close to the best one.
// One rule decides whether a tool is offered at all, so the same kind of message always gets the same answer:
// the message repeats a phrase the tool was written for, or it names the tool's subject and a second word
// agrees. Words only learned from earlier messages ("selam") never offer a tool by themselves; searching
// (rank) stays as forgiving as before.
export function suggest(query, tools, { max = 3, min = HINT_SCORE } = {}) {
  const r = rank(query, tools).filter((x) => x.score >= min && (x.phrase || (x.subject >= 1 && x.hits >= 2)));
  return r.filter((x) => x.score >= r[0]?.score * 0.5).slice(0, max);
}

// The tools a model is asked to judge for a message: the same rule as suggest with a lower bar, since a model
// (the agent itself, or the judge) decides whether one really fits. One shared word is never enough ("queued
// msg" isn't about the PR queue), so a plain request isn't followed by a list of unrelated tools.
export const CANDIDATE_SCORE = 2.5;
export function candidates(query, tools, { max = 4 } = {}) {
  return suggest(query, tools, { max, min: CANDIDATE_SCORE });
}
