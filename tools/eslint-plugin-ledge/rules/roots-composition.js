// EES §9.16 + ADR-025 (E1-T12): composition roots are wiring-only. Their public surface
// is factory functions named bootstrap*/compose*; type exports are free (DI seams),
// but an exported non-factory value would smuggle behavior into the layer that must
// stay boring. Tests are exempt (they import roots to boot them with stub adapters).
const FACTORY = /^(bootstrap|compose)[A-Z]/;
export default {
  meta: {
    type: 'problem',
    messages: {
      nonFactory:
        'Composition roots export only bootstrap*/compose* factories (ADR-025) — found "{{name}}". Move behavior into a layer module.',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (!/[/\\]src[/\\]roots[/\\]/.test(filename) || /\.test\.ts$/.test(filename)) {
      return {};
    }
    const report = (node, name) =>
      context.report({ node, messageId: 'nonFactory', data: { name } });
    return {
      ExportNamedDeclaration(node) {
        if (node.exportKind === 'type') return;
        const d = node.declaration;
        if (d) {
          if (d.type === 'TSInterfaceDeclaration' || d.type === 'TSTypeAliasDeclaration') return;
          if (d.type === 'FunctionDeclaration' && d.id && FACTORY.test(d.id.name)) return;
          report(d, d.type === 'FunctionDeclaration' && d.id ? d.id.name : d.type);
          return;
        }
        for (const spec of node.specifiers) {
          if (spec.exportKind === 'type') continue;
          const name = spec.exported.name ?? spec.exported.value ?? '';
          if (!FACTORY.test(name)) report(spec, name);
        }
      },
      ExportDefaultDeclaration(node) {
        report(node, 'default');
      },
    };
  },
};
