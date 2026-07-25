// §2 copy law (audit P1-G6): surfaces render keys from src/surfaces/components/copy,
// never inline user-facing prose. Applied only to src/surfaces/** outside **/copy/**
// (scoped in eslint.config.js) — copy-lint guards the catalog's CONTENTS; this rule
// guards its CONSUMPTION.
//
// Heuristic by design: flags sentence-like literals (capitalized prose or 4+ word prose
// chains) and ignores technical strings (keys, channels, class chains, URLs, paths).
// Documented limit: short lowercase fragments (<4 words) can pass — they are the
// domain of review, not tooling.
const IGNORE = [
  /^msg\./u, // catalog keys
  /:\/\//u, // URLs
  /^[./~#]/u, // paths, package specifiers, selectors
  /^(chrome|runtime|quiet-page|workroom)[.\w-]*$/u, // platform identifiers / channels
  /^[\w-]+$/u, // single tokens (ids, classes, enum members)
];
const MIN_LENGTH = 12;

const looksLikeUserCopy = (text) => {
  const t = String(text).trim();
  if (t.length < MIN_LENGTH) return false;
  if (IGNORE.some((re) => re.test(t))) return false;
  const words = t.split(/\s+/u);
  if (words.length < 2) return false;
  const capitalizedProse = /^[A-Z]/u.test(t) && /[a-z]/u.test(t) && /[a-z]\s/u.test(t);
  const wordChain = words.length >= 4 && words.every((w) => /^[A-Za-z'’]+[.!?…,:;—]?$/u.test(w));
  return capitalizedProse || wordChain;
};

export default {
  meta: {
    type: 'problem',
    messages: {
      raw: 'Surfaces render catalog keys (src/surfaces/components/copy), not inline copy (§2). Move this string into the catalog.',
    },
    schema: [],
  },
  create(context) {
    const check = (node, text) => {
      if (typeof text === 'string' && looksLikeUserCopy(text))
        context.report({ node, messageId: 'raw' });
    };
    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateLiteral(node) {
        if (node.expressions.length === 0 && node.quasis.length > 0)
          check(node, node.quasis[0].value.cooked);
      },
      JSXText(node) {
        check(node, node.value);
      },
    };
  },
};
