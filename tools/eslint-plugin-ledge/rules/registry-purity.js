// P-08 / §13: files named *.registry.ts / *.catalog.ts are data tables — logic may not hide in them.
export default {
  meta: {
    type: 'problem',
    messages: { logic: 'Registry/catalog files hold data only — move logic to a module.' },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const isRegistry = /\.(registry|catalog)\.(ts|js)$/.test(filename);
    if (!isRegistry) return { Program() {} };
    const report = (node) => context.report({ node, messageId: 'logic' });
    return {
      FunctionDeclaration: report,
      FunctionExpression: report,
      ArrowFunctionExpression(node) {
        // allow array-mapping arrows up to 1 expression deep — keep tables ergonomic
        if (node.body.type !== 'BlockStatement') return;
        report(node);
      },
      ClassDeclaration: report,
    };
  },
};
