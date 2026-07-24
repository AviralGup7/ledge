#!/usr/bin/env node
// Principle 22: calm copy. No exclamation marks, no urgency/shame lexicon, keys follow msg.area.name. [CI]
import { readFileSync } from 'node:fs';
const BANNED = ['!', 'hurry', "don't miss", 'last chance', 'shame', 'guilty', 'act now', 'limited time', 'oops'];
const KEY = /^msg\.[a-z-]+\.[a-z-]+$/;
const catalog = JSON.parse(readFileSync('src/surfaces/components/copy/catalog.json', 'utf8'));
const flat = (o, p = []) => Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [[p.concat(k).join('.'), v]] : flat(v, p.concat(k))));
const problems = [];
for (const [key, text] of flat(catalog)) {
  const leaf = key.split('.').at(-1);
  if (!KEY.test(leaf) && !KEY.test(key)) problems.push(`bad key: ${key}`);
  const bad = BANNED.filter((b) => text.toLowerCase().includes(b));
  if (bad.length) problems.push(`${key}: banned token(s) ${bad.join(', ')} → "${text.slice(0, 60)}"`);
}
if (problems.length) { console.error('COPY LINT:\n' + problems.join('\n')); process.exit(1); }
console.log('copy-lint: calm-copy standard holds.');
