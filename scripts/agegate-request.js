// Emit (and optionally fire+time) the EXACT age-gate request the app sends to
// Groq for a kids "game of" movie search. Body is built through the real
// buildAgePrompt + the same fields callProvider sets, so it's identical to
// production down to response_format / reasoning_effort.
//
//   node scripts/agegate-request.js            # write body.json + print curl
//   MODEL=openai/gpt-oss-20b node scripts/agegate-request.js   # try the small model
//   GROQ_API_KEY=... node scripts/agegate-request.js --run     # fire it, print timing
//
// AGE defaults to 11 to match the reported log; override with AGE=.

const fs = require('fs');
const path = require('path');
const groq = require('../src/services/groq');

const AGE = Number(process.env.AGE) || 11;
const MODEL = process.env.MODEL || 'openai/gpt-oss-120b';
const URL = 'https://api.groq.com/openai/v1/chat/completions';

// The real "game of" movie candidates from the reported search.
const CANDIDATES = [
  { id: 'tt10090796', title: 'Game of Thrones: The Last Watch', year: '2019', genres: ['Documentary'], overview: 'For a year, acclaimed British filmmaker Jeanie Finlay was embedded on the set of the hit HBO series “Game of Thrones,” chronicling the creation of the show’s most ambitious and complex season.' },
  { id: 'tt7136312', title: 'Game of Thrones: The Story So Far', year: '2017', genres: ['Documentary'], overview: 'The story of Game Of thrones before the TV series.' },
  { id: 'tt4732932', title: 'Game of Thrones: Spanish Kingdom Special', year: '2015', genres: ['Documentary'], overview: 'This in-house production is conceived as a chronicle of the Game of Thrones shoot in Seville and Osuna, featuring interviews with key figures involved in the season.' },
  { id: 'tt34382478', title: "Game of Thrones: Aegon's Conquest", genres: ['Action', 'Fantasy', 'Drama'], overview: 'Follows the original conqueror Aegon I Targaryen, taking place roughly 300 years before the events of the Game of Thrones series.' },
  { id: 'tt4437700', title: 'Game of Thrones: A Day in the Life', year: '2015', genres: ['Documentary', 'TV Movie'], overview: 'Glimpse the epic scale of Game of Thrones in this featurette that spends one day touring various Season 5 sets in Croatia, Spain and Ireland.' },
  { id: 'tt7937220', title: 'Game of Thrones - Conquest & Rebellion: An Animated History of the Seven Kingdoms', year: '2017', genres: ['Animation', 'Fantasy', 'War'], overview: 'A powerful ruler from House Targaryen begins a campaign to unite a fractured continent ruled by seven competing families. With the aid of formidable dragons, the Targaryens set out to conquer.' },
];

// Same as services/groq.js REVIEWER_SYSTEM.
const SYSTEM = 'You are a strict parental-guidance reviewer for Australian audiences. Reply with raw JSON only.';

const prompt = groq.buildAgePrompt('movie', AGE, CANDIDATES);

// Exactly what services/llm.js callProvider assembles for a Groq gpt-oss model.
const body = {
  model: MODEL,
  messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: prompt },
  ],
  temperature: 0,
  response_format: { type: 'json_object' },
};
if (/^openai\/gpt-oss/.test(MODEL)) body.reasoning_effort = 'low';

const bodyPath = path.join(__dirname, 'agegate-body.json');
fs.writeFileSync(bodyPath, JSON.stringify(body, null, 2));

console.log(`\nModel: ${MODEL}   Age: ${AGE}   Candidates: ${CANDIDATES.length}`);
console.log(`Body written to: ${bodyPath}\n`);
console.log('Ready-to-run curl (with timing):\n');
console.log(`  curl -s -w '\\n\\nHTTP %{http_code}  total %{time_total}s\\n' \\
    -X POST ${URL} \\
    -H 'Content-Type: application/json' \\
    -H "Authorization: Bearer $GROQ_API_KEY" \\
    --data @${bodyPath}\n`);

if (process.argv.includes('--run')) {
  if (!process.env.GROQ_API_KEY) {
    console.error('--run needs GROQ_API_KEY in the env.');
    process.exit(1);
  }
  (async () => {
    const t0 = Date.now();
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    const elapsed = Date.now() - t0;
    console.log(`--- fired ---  HTTP ${res.status}  ${elapsed}ms`);
    console.log('content:', data.choices?.[0]?.message?.content || JSON.stringify(data).slice(0, 400));
    if (data.usage) console.log('usage:', JSON.stringify(data.usage));
  })().catch((e) => { console.error(e); process.exit(1); });
}
