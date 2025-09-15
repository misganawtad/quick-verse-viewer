const express = require("express");
const cors = require("cors");
const BibleScraper = require("bible-scraper");

const app = express();

// ***** CORS: allow your WP domain *****
const ALLOW_ORIGINS = ["https://misganawtadesse.org"]; // add staging domains if needed
app.use(cors({
  origin: function (origin, cb) {
    // allow same-origin / server-side / curl (no Origin header)
    if (!origin) return cb(null, true);
    cb(null, ALLOW_ORIGINS.includes(origin));
  },
  methods: ["GET", "HEAD", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept"],
  maxAge: 86400, // cache preflight
  credentials: false
}));
// Handle explicit preflight just in case
app.options("*", cors());

// ***** Recommended: always set a sane default content type *****
app.use((req, res, next) => {
  res.type("application/json; charset=utf-8");
  next();
});
