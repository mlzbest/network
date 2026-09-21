import { FlatCompat } from '@eslint/eslintrc';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const flatCompat = new FlatCompat({
  baseDirectory: __dirname,
});

const EXTERNAL_IMPORT_REGEX =
  /@import\s+(?:url\(\s*['"]?((?:https?:)?\/\/[^'")\s]+)['"]?\s*\)|['"]((?:https?:)?\/\/[^'"\s]+)['"])/g;

// CSS远程导入检查插件
const externalImportPlugin = {
  processors: {
    css: {
      preprocess(sourceText) {
        const textLines = sourceText.split('\n');
        const processedLines = textLines.map(line => {
          const importMatches = [...line.matchAll(EXTERNAL_IMPORT_REGEX)];

          if (importMatches.length === 0) {
            return '';
          }

          return importMatches
            .map(match => {
              const importUrl = match[1] ?? match[2];
              return `__cssExternalImport(${JSON.stringify(importUrl)});`;
            })
            .join(' ');
        });

        return [processedLines.join('\n')];
      },
      postprocess(messagesList) {
        return messagesList.flat();
      },
      supportsAutofix: false,
    },
  },
};

// app.config.ts tabBar 图标存在性检查（作用域限定在 files 字段里，见下方配置）
const tabbarIconExistPlugin = {
  rules: {
    'tabbar-icon-exists': {
      create(context) {
        const srcDir = path.dirname(context.filename);
        return {
          "Property[key.name=/^(iconPath|selectedIconPath)$/]"(node) {
            const v = node.value;
            if (v.type !== 'Literal' || typeof v.value !== 'string') return;
            const p = v.value;
            if (!/\.png$/i.test(p)) {
              context.report({
                node: v,
                message: `tabBar 图标必须是 PNG（微信 TabBar 不支持 SVG）: "${p}"`,
              });
              return;
            }
            if (!fs.existsSync(path.resolve(srcDir, p))) {
              context.report({
                node: v,
                message: `tabBar 图标文件不存在: "${p}"。用 \`npx taro-lucide-tabbar\` 生成到 src/assets/tabbar/`,
              });
            }
          },
        };
      },
    },
  },
};

// 基础语法限制规则
const coreRestrictedSyntaxRules = [
  {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message:
      'src目录规范：请勿直接使用process.env访问环境变量',
  },
  {
    selector:
      'Literal[value=/(^|\\s)(?:[^\\s:]+:)*(bg|text|border|divide|outline|ring|ring-offset|from|to|via|decoration|shadow|accent|caret|fill|stroke)-[a-z0-9-]+\\/([0-9]+|\\[[^\\]]+\\])/], TemplateElement[value.raw=/(^|\\s)(?:[^\\s:]+:)*(bg|text|border|divide|outline|ring|ring-offset|from|to|via|decoration|shadow|accent|caret|fill|stroke)-[a-z0-9-]+\\/([0-9]+|\\[[^\\]]+\\])/]',
    message:
      '小程序兼容性：禁用 Tailwind 颜色透明度简写（如 bg-primary/10），小程序下 opacity 会丢失。请用 inline style={{ backgroundColor: \'rgba(...)\' }}。',
  },
  {
    selector:
      'Literal[value=/(^|\\s)(?:[^\\s:]+:)*(bg|text|border|divide|ring|placeholder)-opacity-(?:[0-9]+|\\[[^\\]]+\\])/], TemplateElement[value.raw=/(^|\\s)(?:[^\\s:]+:)*(bg|text|border|divide|ring|placeholder)-opacity-(?:[0-9]+|\\[[^\\]]+\\])/]',
    message:
      '小程序兼容性：禁用 Tailwind *-opacity-* 写法（如 bg-opacity-20 / text-opacity-50），小程序下 opacity 会丢失。请用 inline style={{ backgroundColor: \'rgba(...)\' }}',
  },
  {
    selector:
      ":matches(JSXAttribute[name.name='className'], CallExpression[callee.name=/^(cn|cva)$/]) :matches(Literal[value=/(^|\\s)peer-[a-z0-9-]+\\b/], TemplateElement[value.raw=/(^|\\s)peer-[a-z0-9-]+\\b/])",
    message:
      '小程序兼容性：不支持Tailwind的peer-*修饰符（如peer-checked、peer-disabled）',
  },
  {
    selector:
      ":matches(JSXAttribute[name.name='className'], CallExpression[callee.name=/^(cn|cva)$/]) :matches(Literal[value=/(^|\\s)group-[a-z0-9-]+\\b/], TemplateElement[value.raw=/(^|\\s)group-[a-z0-9-]+\\b/])",
    message: '小程序兼容性：不支持Tailwind的group-*修饰符（如group-hover）',
  },
  {
    selector:
      ":matches(JSXAttribute[name.name='className'], CallExpression[callee.name=/^(cn|cva)$/]) :matches(Literal[value=/\\b(?!gap(?:-x|-y)?-)[a-zA-Z0-9-]+\\-[0-9]+\\.[0-9]+\\b/], TemplateElement[value.raw=/\\b(?!gap(?:-x|-y)?-)[a-zA-Z0-9-]+\\-[0-9]+\\.[0-9]+\\b/])",
    message:
      '小程序兼容性：禁用Tailwind小数值类名（如space-y-1.5、w-0.5），请使用整数替代（如space-y-2、w-1）',
  },
  {
    selector:
      ":matches(JSXAttribute[name.name='className'], CallExpression[callee.name=/^(cn|cva)$/]) :matches(Literal[value=/\\:has\\(/], TemplateElement[value.raw=/\\:has\\(/])",
    message: '小程序兼容性：WXSS不支持:has(...)选择器（会导致预览上传失败）',
  },
  {
    selector:
      ":matches(JSXAttribute[name.name='className'], CallExpression[callee.name=/^(cn|cva)$/]) :matches(Literal[value=/(^|\\s)has-[^\\s]+/], TemplateElement[value.raw=/(^|\\s)has-[^\\s]+/])",
    message:
      '小程序兼容性：禁用Tailwind的has-*变体（会生成:has选择器，导致预览上传失败）',
  },
  {
    selector:
      ":matches(JSXAttribute[name.name='className'], CallExpression[callee.name=/^(cn|cva)$/]) :matches(Literal[value=/\\[&>\\*/], TemplateElement[value.raw=/\\[&>\\*/])",
    message:
      '小程序兼容性：禁用[&>*...]通配符选择器（可能生成非法WXSS），请使用明确标签如[&>view]',
  },
  {
    selector:
      ":matches(JSXAttribute[name.name='className'], CallExpression[callee.name=/^(cn|cva)$/]) :matches(Literal[value=/\\[&[^\\]]*\\[data-/], TemplateElement[value.raw=/\\[&[^\\]]*\\[data-/])",
    message:
      '小程序兼容性：禁用任意选择器中的属性选择器（如[&>[data-...]]），可能导致预览上传失败',
  },
  {
    selector:
      ":matches(JSXAttribute[name.name='className'], CallExpression[callee.name=/^(cn|cva)$/]) :matches(Literal[value=/\\[[^\\]]*&[^\\]]*~[^\\]]*\\]/], TemplateElement[value.raw=/\\[[^\\]]*&[^\\]]*~[^\\]]*\\]/])",
    message: '小程序兼容性：WXSS不支持兄弟选择器~（会导致预览上传失败）',
  },
  {
    selector:
      "CallExpression[callee.name='__cssExternalImport'] > Literal[value=/^(?:https?:)?\\/\\//]",
    message:
      '小程序兼容性：禁止CSS中使用远程@import（如Google Fonts），请改为本地静态资源',
  },
  {
    selector:
      "JSXAttribute[name.name='color'][value.type='Literal'][value.value='currentColor'], JSXAttribute[name.name='color'] > JSXExpressionContainer > Literal[value='currentColor']",
    message:
      '图标组件规范：禁止使用color="currentColor"，小程序端不会按预期继承颜色，请改为显式颜色值或通过Provider提供默认颜色',
  },
  {
    selector:
      "JSXOpeningElement[name.name='ScrollView'] JSXAttribute[name.name='className'] :matches(Literal[value=/(?:^|\\s)(?:px|pl|pr|ps|pe|p)-/], TemplateElement[value.raw=/(?:^|\\s)(?:px|pl|pr|ps|pe|p)-/])",
    message:
      'ScrollView 不要加水平 padding（p-*/px-*/pl-*/pr-*/ps-*/pe-*）：子元素 w-full 会基于含 padding 的内容区计算宽度而溢出视口。请把水平 padding 移到 ScrollView 内部容器上',
  },
];

export default [
  ...flatCompat.extends('taro/react'),
  {
    rules: {
      'react/jsx-uses-react': 'off',
      'react/react-in-jsx-scope': 'off',
      'jsx-quotes': ['error', 'prefer-double'],
      'react-hooks/exhaustive-deps': 'off',
      'tailwindcss/classnames-order': 'off',
      'tailwindcss/no-custom-classname': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    files: ['src/**/*.{js,jsx,ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...coreRestrictedSyntaxRules],
      'no-restricted-properties': [
        'error',
      ],
    },
  },
  {
    files: ['src/**/*.css'],
    plugins: {
      local: externalImportPlugin,
    },
    processor: 'local/css',
    rules: {
      'no-undef': 'off',
      'no-restricted-syntax': ['error', ...coreRestrictedSyntaxRules],
    },
  },
  {
    files: ['src/app.config.{ts,tsx,js,jsx,mjs,cjs}'],
    plugins: {
      local: tabbarIconExistPlugin,
    },
    rules: {
      'local/tabbar-icon-exists': 'error',
    },
  },
  {
    ignores: ['dist/**', 'dist-*/**', 'node_modules/**'],
  },
];
