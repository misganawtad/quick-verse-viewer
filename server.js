const express = require("express");
const cors = require("cors");
const BibleScraper = require("bible-scraper");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static("public")); // serves public/index.html

// ---- tiny request logger ----
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ---- helpers ----
function cleanPunct(s) {
  return String(s ?? "")
    .replace(/<<\s*/g, "“") // opening quote
    .replace(/\s*>>/g, "”") // closing quote
    .replace(/\*/g, "");    // remove all asterisks
}
function oneLine(s) {
  return cleanPunct(s)
    .replace(/[\r\n\u000B\u000C\u0085\u2028\u2029]+/g, " ") // all line breaks
    .replace(/\u00A0/g, " ")                                // NBSP -> space
    .replace(/[\u200B-\u200D\uFEFF]/g, "")                  // zero-width chars
    .replace(/\s{2,}/g, " ")                                // collapse spaces
    .trim();
}

// Promise timeout wrapper
function withTimeout(promise, ms, label = "operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms)
    ),
  ]);
}

// Cache scrapers by translation id
const cache = new Map();
const getScraper = (id) => {
  if (!cache.has(id)) cache.set(id, new BibleScraper(id));
  return cache.get(id);
};

// ---- Name ↔ Code mapping (66 books + common aliases) ----
const NAME_TO_CODE = {
  // OT
  "genesis":"GEN","exodus":"EXO","leviticus":"LEV","numbers":"NUM","deuteronomy":"DEU",
  "joshua":"JOS","judges":"JDG","ruth":"RUT",
  "1 samuel":"1SA","2 samuel":"2SA","i samuel":"1SA","ii samuel":"2SA",
  "1 kings":"1KI","2 kings":"2KI","i kings":"1KI","ii kings":"2KI",
  "1 chronicles":"1CH","2 chronicles":"2CH","i chronicles":"1CH","ii chronicles":"2CH",
  "ezra":"EZR","nehemiah":"NEH","esther":"EST","job":"JOB",
  "psalms":"PSA","psalm":"PSA","ps":"PSA",
  "proverbs":"PRO","prov":"PRO",
  "ecclesiastes":"ECC","qoheleth":"ECC","eccles":"ECC",
  "song of songs":"SNG","song of solomon":"SNG","canticles":"SNG","songs":"SNG",
  "isaiah":"ISA","jeremiah":"JER","lamentations":"LAM","lam":"LAM",
  "ezekiel":"EZK","ezechiel":"EZK","daniel":"DAN",
  "hosea":"HOS","joel":"JOL","amos":"AMO","obadiah":"OBA","jonah":"JON",
  "micah":"MIC","nahum":"NAM","habakkuk":"HAB","zephaniah":"ZEP",
  "haggai":"HAG","zechariah":"ZEC","malachi":"MAL",
  // NT
  "matthew":"MAT","mark":"MRK","luke":"LUK","john":"JHN","acts":"ACT",
  "romans":"ROM","1 corinthians":"1CO","2 corinthians":"2CO","i corinthians":"1CO","ii corinthians":"2CO",
  "galatians":"GAL","ephesians":"EPH","philippians":"PHP","colossians":"COL",
  "1 thessalonians":"1TH","2 thessalonians":"2TH","i thessalonians":"1TH","ii thessalonians":"2TH",
  "1 timothy":"1TI","2 timothy":"2TI","i timothy":"1TI","ii timothy":"2TI",
  "titus":"TIT","philemon":"PHM","hebrews":"HEB","james":"JAS",
  "1 peter":"1PE","2 peter":"2PE","i peter":"1PE","ii peter":"2PE",
  "1 john":"1JN","2 john":"2JN","3 john":"3JN","i john":"1JN","ii john":"2JN","iii john":"3JN",
  "jude":"JUD","revelation":"REV","revelations":"REV","apocalypse":"REV"
};
const VALID_CODES = new Set(Object.values(NAME_TO_CODE));
const norm = s => String(s).replace(/\./g, "").replace(/\s+/g, " ").trim().toLowerCase();
function bookToCode(raw){
  const clean = norm(raw);
  const maybeCode = clean.replace(/\s+/g, "").toUpperCase(); // 1CO
  if (VALID_CODES.has(maybeCode)) return maybeCode;
  if (NAME_TO_CODE[clean]) return NAME_TO_CODE[clean];
  const hit = Object.keys(NAME_TO_CODE).find(k => k.startsWith(clean));
  return hit ? NAME_TO_CODE[hit] : null;
}

// ---- /api/verse ----
// GET /api/verse?ref=John%203:16&ver=3202
app.get("/api/verse", async (req, res) => {
  try {
    const input = String(req.query.ref || "").trim();
    const ver = Number(req.query.ver);
    if (!input || !ver) return res.status(400).json({ ok:false, error:"Missing ref or ver" });

    const m = input.match(/^([\d]?\s*[A-Za-z .]+)\s+(\d+)(?::(\d+)(?:-(\d+))?)?$/);
    if (!m) return res.status(400).json({ ok:false, error:"Bad reference. Try 'John 3:16'." });

    const [, rawBook, chapStr, vStartStr, vEndStr] = m;
    const chapter = Number(chapStr);
    const vStart = vStartStr ? Number(vStartStr) : undefined;
    const vEnd   = vEndStr ? Number(vEndStr) : vStart;

    const code = bookToCode(rawBook);
    if (!code) return res.status(400).json({ ok:false, error:`Unknown book '${rawBook}'` });

    const scraper = getScraper(ver);
    const chapterRef = `${code}.${chapter}`;
    const verseRef   = vStart ? `${code}.${chapter}.${vStart}` : null;

    // timeouts (ms)
    const TO = { verse: 12000, chapter: 12000 };

    if (vStart) {
      try {
        const v = await withTimeout(scraper.verse(verseRef), TO.verse, "verse fetch");
        return res.json({ ok:true, data: { ...v, content: oneLine(v.content) } });
      } catch (e) {
        console.warn("verse() failed, falling back to chapter():", e.message);
        try {
          const ch = await withTimeout(scraper.chapter(chapterRef), TO.chapter, "chapter fetch");
          const slice = (ch.verses || [])
            .filter(v => {
              const n = Number(String(v.reference).split(".").pop());
              return n >= vStart && n <= vEnd;
            })
            .map(v => oneLine(v.content))
            .join(" ");
          return res.json({ ok:true, data: { content: oneLine(slice), reference: input } });
        } catch (e2) {
          console.error("chapter() fallback failed:", e2.message);
          return res.status(504).json({ ok:false, error:"Upstream timeout. Please try again." });
        }
      }
    } else {
      try {
        const ch = await withTimeout(scraper.chapter(chapterRef), TO.chapter, "chapter fetch");
        const normalized = {
          ...ch,
          verses: (ch.verses || []).map(v => ({ ...v, content: oneLine(v.content) }))
        };
        return res.json({ ok:true, data: normalized });
      } catch (e) {
        console.error("chapter() fetch failed:", e.message);
        return res.status(504).json({ ok:false, error:"Upstream timeout. Please try again." });
      }
    }
  } catch (e) {
    console.error("handler error:", e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
