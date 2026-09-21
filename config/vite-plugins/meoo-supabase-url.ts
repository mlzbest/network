import type { Plugin } from 'vite';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import MagicString from 'magic-string';

const traverse = ((_traverse as any).default ?? _traverse) as typeof _traverse;

export interface MeooSupabaseUrlPluginOptions {
  url: string;
  urlId: string;
}

function findProp(
  obj: t.ObjectExpression,
  keyName: string,
): t.ObjectProperty | null {
  for (const prop of obj.properties) {
    if (!t.isObjectProperty(prop)) continue;
    const key = prop.key;
    if (t.isStringLiteral(key) && key.value === keyName) return prop;
    if (t.isIdentifier(key) && key.name === keyName) return prop;
  }
  return null;
}

function appendInto(
  s: MagicString,
  obj: t.ObjectExpression,
  propText: string,
): void {
  if (obj.properties.length === 0) {
    s.appendLeft(obj.start! + 1, ` ${propText} `);
    return;
  }
  const lastProp = obj.properties[obj.properties.length - 1];
  s.appendRight(lastProp.end!, `, ${propText}`);
}

/**
 * Ensure `options.auth.storageKey === <value>`. Inserts missing intermediate
 * objects when needed, otherwise replaces the existing literal.
 */
function ensureAuthStorageKey(
  s: MagicString,
  options: t.ObjectExpression,
  valueLiteral: string,
): void {
  const authProp = findProp(options, 'auth');
  if (!authProp || !t.isObjectExpression(authProp.value)) {
    appendInto(s, options, `auth: { storageKey: ${valueLiteral} }`);
    return;
  }

  const storageKeyProp = findProp(authProp.value, 'storageKey');
  if (storageKeyProp && t.isStringLiteral(storageKeyProp.value)) {
    s.overwrite(storageKeyProp.value.start!, storageKeyProp.value.end!, valueLiteral);
    return;
  }

  appendInto(s, authProp.value, `storageKey: ${valueLiteral}`);
}

export function meooSupabaseUrlPlugin(
  options: MeooSupabaseUrlPluginOptions,
): Plugin {
  const { url, urlId } = options;

  return {
    name: 'meoo-supabase-url-replace',
    enforce: 'pre',
    transform(code, id) {
      if (!/\/supabase\/client\.tsx?$/.test(id)) return null;

      const isWeapp = process.env.TARO_ENV === 'weapp';
      if (!isWeapp) return null;

      const canBuildUrl = !!url && !!urlId;
      const canSetStorageKey = !!urlId;

      if (!url) {
        this.warn(
          '[meoo-supabase-url] meoo["api-url"] is empty in package.json; skipping URL replacement.',
        );
      }
      if (!urlId) {
        this.warn(
          '[meoo-supabase-url] meoo["app-id"] is empty in package.json; skipping URL/storageKey replacement.',
        );
      }

      if (!canBuildUrl && !canSetStorageKey) return null;

      let ast;
      try {
        ast = parse(code, {
          sourceType: 'module',
          plugins: ['typescript'],
        });
      } catch (err) {
        this.warn(
          `[meoo-supabase-url] failed to parse client.ts: ${(err as Error).message}`,
        );
        return null;
      }

      const s = new MagicString(code);
      const urlLiteral = canBuildUrl
        ? JSON.stringify(`${url.replace(/\/+$/, '')}/mp-api/${urlId}`)
        : null;
      let hitUrl = false;
      let hitStorageKey = false;
      let createClientOptions: t.ObjectExpression | null = null;

      traverse(ast, {
        FunctionDeclaration(p) {
          if (!canBuildUrl || hitUrl) return;
          if (p.node.id?.name !== 'getSupabaseUrl') return;
          // 替换整个函数体为直接返回 URL
          s.overwrite(
            p.node.body.start!,
            p.node.body.end!,
            `{ return ${urlLiteral}; }`
          );
          hitUrl = true;
          p.skip();
        },
        VariableDeclarator(p) {
          if (!canBuildUrl || hitUrl) return;
          if (!t.isIdentifier(p.node.id, { name: 'getSupabaseUrl' })) return;
          const init = p.node.init;
          if (
            !init ||
            (!t.isArrowFunctionExpression(init) && !t.isFunctionExpression(init))
          ) {
            return;
          }
          s.overwrite(init.start!, init.end!, `(): string => ${urlLiteral}`);
          hitUrl = true;
          p.skip();
        },
        CallExpression(p) {
          if (createClientOptions) return;
          const callee = p.node.callee;
          if (!t.isIdentifier(callee, { name: 'createClient' })) return;
          const args = p.node.arguments;
          const last = args[args.length - 1];
          if (t.isObjectExpression(last)) {
            createClientOptions = last;
          }
        },
      });

      if (canBuildUrl && !hitUrl) {
        this.warn(
          '[meoo-supabase-url] getSupabaseUrl declaration not found in client.ts',
        );
      }

      if (canSetStorageKey) {
        if (!createClientOptions) {
          this.warn(
            '[meoo-supabase-url] createClient(...) options object not found in client.ts',
          );
        } else {
          ensureAuthStorageKey(
            s,
            createClientOptions,
            JSON.stringify(`${urlId}-auth-token`),
          );
          hitStorageKey = true;
        }
      }

      if (!hitUrl && !hitStorageKey) return null;

      return { code: s.toString(), map: s.generateMap({ hires: true }) };
    },
  };
}
