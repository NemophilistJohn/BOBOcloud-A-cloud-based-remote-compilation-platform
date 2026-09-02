'use strict';

const ts = require('typescript');

const GLOBAL_NAMES = new Set(['window', 'global', 'globalThis', 'self']);

function directBridgeAccessCount(file, source) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
  );
  const globalAliases = new Set(GLOBAL_NAMES);

  function unwrap(expression) {
    let current = expression;
    while (current && (
      ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)
    )) current = current.expression;
    return current;
  }

  function staticPropertyName(name) {
    if (!name) return null;
    const candidate = unwrap(name);
    if (ts.isIdentifier(candidate) || ts.isStringLiteralLike(candidate)) return candidate.text;
    if (ts.isComputedPropertyName(candidate)) {
      const expression = unwrap(candidate.expression);
      return ts.isStringLiteralLike(expression) ? expression.text : null;
    }
    return null;
  }

  function isGlobalAlias(expression) {
    const candidate = unwrap(expression);
    if (!candidate) return false;
    if (ts.isIdentifier(candidate)) return globalAliases.has(candidate.text);
    if (ts.isPropertyAccessExpression(candidate)) {
      return GLOBAL_NAMES.has(candidate.name.text) && isGlobalAlias(candidate.expression);
    }
    if (ts.isElementAccessExpression(candidate)) {
      return staticPropertyName(candidate.argumentExpression) !== null &&
        GLOBAL_NAMES.has(staticPropertyName(candidate.argumentExpression)) &&
        isGlobalAlias(candidate.expression);
    }
    return false;
  }

  function addGlobalBindingAliases(pattern, initializer) {
    if (!isGlobalAlias(initializer)) return false;
    let changed = false;
    if (ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        const property = staticPropertyName(element.propertyName || element.name);
        if (GLOBAL_NAMES.has(property) && ts.isIdentifier(element.name) && !globalAliases.has(element.name.text)) {
          globalAliases.add(element.name.text);
          changed = true;
        }
      }
    } else if (ts.isObjectLiteralExpression(pattern)) {
      for (const property of pattern.properties) {
        const propertyName = staticPropertyName(property.name);
        const target = ts.isPropertyAssignment(property)
          ? unwrap(property.initializer)
          : (ts.isShorthandPropertyAssignment(property) ? property.name : null);
        if (GLOBAL_NAMES.has(propertyName) && target && ts.isIdentifier(target) && !globalAliases.has(target.text)) {
          globalAliases.add(target.text);
          changed = true;
        }
      }
    }
    return changed;
  }

  let changed;
  do {
    changed = false;
    function collectAliases(node) {
      if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name) && isGlobalAlias(node.initializer) && !globalAliases.has(node.name.text)) {
          globalAliases.add(node.name.text);
          changed = true;
        } else if (node.initializer && addGlobalBindingAliases(node.name, node.initializer)) {
          changed = true;
        }
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = unwrap(node.left);
        if (ts.isIdentifier(left) && isGlobalAlias(node.right) && !globalAliases.has(left.text)) {
          globalAliases.add(left.text);
          changed = true;
        } else if (addGlobalBindingAliases(left, node.right)) {
          changed = true;
        }
      }
      ts.forEachChild(node, collectAliases);
    }
    collectAliases(sourceFile);
  } while (changed);

  function apiBindingCount(pattern) {
    if (ts.isObjectBindingPattern(pattern)) {
      return pattern.elements.filter((element) => (
        staticPropertyName(element.propertyName || element.name) === 'api'
      )).length;
    }
    if (ts.isObjectLiteralExpression(pattern)) {
      return pattern.properties.filter((property) => staticPropertyName(property.name) === 'api').length;
    }
    return 0;
  }

  let count = 0;
  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'api' && isGlobalAlias(node.expression)) {
      count += 1;
    } else if (ts.isElementAccessExpression(node) && isGlobalAlias(node.expression) &&
        staticPropertyName(node.argumentExpression) === 'api') {
      count += 1;
    } else if (ts.isVariableDeclaration(node) && node.initializer && isGlobalAlias(node.initializer)) {
      count += apiBindingCount(node.name);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isGlobalAlias(node.right)) {
      count += apiBindingCount(unwrap(node.left));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return count;
}

module.exports = { directBridgeAccessCount };
