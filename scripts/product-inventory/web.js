'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Parse the actual route arrays, without executing a build config or loading Umi.
function collectWebEntries(root) {
  const ts = require(require.resolve('typescript', { paths: [path.join(root, 'web')] }));
  const file = 'web/config/routes.ts';
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const entries = [];
  const unresolved = [];
  function literal(node) {
    return node && ts.isStringLiteralLike(node) ? node.text : undefined;
  }
  function walkRoutes(array, profile, ancestry = []) {
    for (const [index, route] of array.elements.entries()) {
      const location = [...ancestry, index];
      if (!ts.isObjectLiteralExpression(route)) {
        unresolved.push({ source: file, expression: route.getText(source), reason: 'dynamic_route' });
        continue;
      }
      const fields = new Map();
      for (const prop of route.properties) {
        if (ts.isPropertyAssignment(prop)) fields.set(prop.name.getText(source).replace(/['"]/g, ''), prop.initializer);
      }
      const routePath = literal(fields.get('path'));
      if (routePath) {
        entries.push({
          id: `web:${profile}:${location.join('.')}:${routePath}`,
          surface: 'web', entry: routePath, profile,
          description: literal(fields.get('name')) || '',
          component: literal(fields.get('component')) || null,
          redirect: literal(fields.get('redirect')) || null,
          evidence: 'declared_route', source: file,
          line: source.getLineAndCharacterOfPosition(route.getStart(source)).line + 1
        });
      } else {
        unresolved.push({ source: file, expression: route.getText(source), reason: 'missing_static_path' });
      }
      const children = fields.get('routes');
      if (children && ts.isArrayLiteralExpression(children)) walkRoutes(children, profile, location);
    }
  }
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (decl.initializer && ts.isArrayLiteralExpression(decl.initializer)) walkRoutes(decl.initializer, decl.name.getText(source));
    }
  }
  return { entries, unresolved };
}

module.exports = { collectWebEntries };
