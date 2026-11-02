// Creative thumbnails for the dashboard, used by the refresh routine. Needs MM_PASS in the environment.
// Meta ads show their own thumbnail. Snapchat, TikTok and X ads borrow the thumbnail of the same creative on Meta, matched by ad name within the same client + campaign.
// meta-ads.json = [{id, name, creative_id, client, campaign}], every Meta ad of the campaigns behind Active/Launched lines, any status.
//   node tools/mmthumbs.js need meta-ads.json                  prints the creative ids with no stored thumbnail
//   node tools/mmthumbs.js apply lines.json meta-ads.json urls.json   urls.json = {creative_id: thumbnail_url}; stores new ones, sets `thumb` on every creative
const crypto = require('crypto'), fs = require('fs'), https = require('https'), path = require('path');
const CACHE = path.join(__dirname, '..', 'data', 'thumbs.enc.json'), ITER = 600000;

function readCache() {
  if (!fs.existsSync(CACHE)) return {};
  const e = JSON.parse(fs.readFileSync(CACHE, 'utf8'))[0];
  const key = crypto.pbkdf2Sync(process.env.MM_PASS, Buffer.from(e.salt, 'base64'), e.iter, 32, 'sha256');
  const buf = Buffer.from(e.ct, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8'));
}
function writeCache(obj) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12), key = crypto.pbkdf2Sync(process.env.MM_PASS, salt, ITER, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', key, iv), ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
  fs.writeFileSync(CACHE, JSON.stringify([{ v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') }]));
}
const download = u => new Promise(res => {
  https.get(u, { timeout: 15000 }, r => { const b = []; r.on('data', d => b.push(d)); r.on('end', () => res(r.statusCode === 200 && /^image\//.test(r.headers['content-type'] || '') ? 'data:' + r.headers['content-type'] + ';base64,' + Buffer.concat(b).toString('base64') : null)); })
    .on('error', () => res(null)).on('timeout', function () { this.destroy(); });
});

// ---------- name matching
const TALENT = [[/youss?ef|yousef|sedeqqi|siddiqi/i, 'youssef'], [/bahri|bahry|b7ry/i, 'b7ry'], [/aa?lia+\b/i, 'aliaa'], [/razz?aq/i, 'razaq'], [/\bomar\b/i, 'omar'], [/faisal/i, 'faisal']];
const SUBJECT = /\b(NX|IS|RX|RZ|LX|UX|LS|ES|GX|LBX|FJ)\b/g;
const WORDS = [[/batter/i, 'battery'], [/\bworld\b/i, 'world'], [/\blogo\b/i, 'logo'], [/\bcamry\b/i, 'camry'], [/\bcrown\b/i, 'crown'], [/\bprado\b/i, 'prado'], [/\bcorolla\b/i, 'corolla'], [/\brav ?4\b/i, 'rav4'], [/urban cruiser/i, 'urban']];
function parse(name) {
  const full = String(name || '');
  // TikTok names start with a file name or caption; the ad's own name is the last "Ad N …" or "NNN_NN_NN …" part.
  const m = full.match(/(?:Ad \d+|\d{2,3}_\d{2}_\d{1,2})(?:(?!_Ad \d|_\d{2,3}_\d{2}_).)*$/s);
  const t = m ? m[0] : full;
  const fmt = /carou?s|carosuel/i.test(t) ? 'carousel' : /ugc/i.test(t) ? 'ugc' : /animation/i.test(t) ? 'animation' : /static/i.test(t) ? 'static' : /\bAI\b/.test(t) ? 'ai' : null;
  const lang = /\bAR\b/.test(t) ? 'ar' : /\bEN\b/.test(t) ? 'en' : null;
  const seq = (t.match(/^Ad (\d+)/) || t.match(/^\d{2,3}_\d{2}_0*(\d+)/) || [])[1] || null;
  const month = (t.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/) || [])[1] || null;
  const talent = (TALENT.find(([re]) => re.test(full)) || [])[1] || null;
  const subj = new Set(t.match(SUBJECT) || []); for (const [re, w] of WORDS) if (re.test(t)) subj.add(w);
  return { fmt, lang, seq, month, talent, subj };
}
function score(a, b) {
  if (a.lang && b.lang && a.lang !== b.lang) return 0;
  if (a.month && b.month && a.month !== b.month) return 0;
  if (a.talent || b.talent) return a.talent === b.talent ? 10 + (a.seq === b.seq) : 0;
  const both = a.subj.size && b.subj.size, overlap = both ? [...a.subj].filter(x => b.subj.has(x)).length : 0;
  if (both && !overlap) return 0;
  const sameFmt = a.fmt && a.fmt === b.fmt;
  if (!sameFmt && !overlap) return 0;
  return (sameFmt ? 2 : 0) + overlap * 3 + (a.lang && a.lang === b.lang ? 1 : 0) + (a.seq && a.seq === b.seq ? 1 : 0) + (a.month && a.month === b.month ? 1 : 0);
}
const sameAd = t => { const s = new Set(t.map(o => o.p.seq + '|' + [...o.p.subj].sort() + '|' + o.p.fmt)); return s.size === 1; };

function assign(lines, ads, cache) {
  const own = {}, pool = {}, stat = { own: 0, borrowed: 0, none: [] };
  for (const a of ads) {
    if (!cache[a.creative_id]) continue;
    own[a.id] = cache[a.creative_id];
    (pool[a.client + '|' + a.campaign] = pool[a.client + '|' + a.campaign] || []).push({ name: a.name, thumb: cache[a.creative_id], p: parse(a.name) });
  }
  const metaIds = new Set(ads.map(a => String(a.id)));
  for (const r of lines) for (const c of r.creatives || []) {
    delete c.thumb; delete c.thumb_from;
    if (metaIds.has(String(c.id))) { if (own[c.id]) { c.thumb = own[c.id]; stat.own++; } else stat.none.push(r.channel + ': ' + c.name); continue; }
    const p = parse(c.name); let best = 0, top = [];
    for (const o of pool[r.client + '|' + r.campaign] || []) { const s = score(p, o.p); if (s > best) { best = s; top = [o]; } else if (s && s === best) top.push(o); }
    // Several candidates are fine when they are one image, or the same ad repeated across ad sets. Otherwise leave it blank rather than guess.
    if (top.length && (new Set(top.map(o => o.thumb)).size === 1 || sameAd(top))) { c.thumb = top[0].thumb; c.thumb_from = top[0].name; stat.borrowed++; } else stat.none.push(r.channel + ': ' + String(c.name).slice(-60));
  }
  return stat;
}

(async () => {
  const [mode, a, b, c] = process.argv.slice(2);
  if (!process.env.MM_PASS) throw new Error('MM_PASS is not set');
  if (mode === 'need') {
    const cache = readCache(), ads = JSON.parse(fs.readFileSync(a, 'utf8'));
    console.log(JSON.stringify([...new Set(ads.map(x => String(x.creative_id)))].filter(id => !cache[id])));
  } else if (mode === 'apply') {
    const lines = JSON.parse(fs.readFileSync(a, 'utf8')), ads = JSON.parse(fs.readFileSync(b, 'utf8')), urls = c && fs.existsSync(c) ? JSON.parse(fs.readFileSync(c, 'utf8')) : {};
    const cache = readCache(), linked = { ...cache }; let added = 0, failed = 0;
    // If the image server can't be reached from here, link the Meta URL itself for this run (it expires in a few days; the next run renews it).
    for (const [id, u] of Object.entries(urls)) { if (cache[id]) continue; const d = await download(u); if (d) { cache[id] = linked[id] = d; added++; } else { failed++; if (/^https:\/\/[a-z0-9.-]+\.fbcdn\.net\//.test(u)) linked[id] = u; } }
    if (added) writeCache(cache);
    const s = assign(lines, ads, linked);
    fs.writeFileSync(a, JSON.stringify(lines));
    console.log(JSON.stringify({ downloaded: added, download_failed: failed, own: s.own, borrowed: s.borrowed, no_thumb: s.none.length }));
    for (const n of s.none) console.log('no thumb: ' + n);
  } else throw new Error('use: need | apply');
})().catch(e => { console.error(e.message); process.exit(1); });
