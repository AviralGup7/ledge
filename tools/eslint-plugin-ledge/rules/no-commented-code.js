// Constitution §2: no commented-out code. Comments explain WHY; dead code lives in git history.
// Heuristic: block comments whose content parses suspiciously like code are flagged.
const CODE_PATTERNS = [
  /^\s*(import|export|const|let|var|function|return|if\s*\(|for\s*\(|await\s+\w|chrome\.)/m,
  /[{};]\s*$/m,
];
export default {
  meta: { type: 'problem', messages: { commented: 'Commented-out code detected — delete it. History remembers.' }, schema: [] },
  create(context) {
    const source = context.sourceCode;
    return {
      Program() {
        for (const comment of source.getAllComments()) {
          const text = comment.value.trim();
          if (text.length < 12) continue;
          if (CODE_PATTERNS.every((re) => re.test(text))) {
            context.report({ loc: comment.loc, messageId: 'commented' });
          }
        }
      },
    };
  },
};
