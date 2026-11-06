import { View, Text } from '@tarojs/components';
import type { ReactNode } from 'react';

/**
 * 轻量 Markdown 渲染（零 DOM 依赖，纯 Taro 组件树，适配小程序）。
 * 支持：# 标题、**加粗**、*斜体*、`行内代码`、```代码块```、
 *       - / • 无序列表、1. 有序列表、> 引用、--- 分割线、[文本](链接)。
 * 设计目标：AI 回复流式增量重渲染开销小——逐行解析，不做完整 CommonMark。
 */

interface MarkdownTextProps {
  content: string;
  /** 基础文字类名（继承气泡的 text-sm leading-relaxed 等） */
  baseClass?: string;
}

/** 行内元素解析：加粗 > 斜体 > 行内代码 > 链接，返回嵌套 <Text> 序列 */
function parseInline(raw: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // 统一匹配五种行内语法，按出现顺序切分
  const pattern =
    /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))|(~~([^~]+)~~)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let ki = 0;
  while ((m = pattern.exec(raw)) !== null) {
    if (m.index > last) nodes.push(raw.slice(last, m.index));
    const key = `${keyPrefix}-i${ki++}`;
    if (m[2] !== undefined) {
      nodes.push(
        <Text key={key} className="font-bold">
          {m[2]}
        </Text>,
      );
    } else if (m[4] !== undefined) {
      nodes.push(
        <Text key={key} className="italic">
          {m[4]}
        </Text>,
      );
    } else if (m[6] !== undefined) {
      nodes.push(
        <Text key={key} className="bg-muted rounded px-1 font-mono text-xs">
          {m[6]}
        </Text>,
      );
    } else if (m[8] !== undefined) {
      // 链接：小程序 Text 不可点击跳转外链，展示「文本(url)」并 selectable 供长按复制
      nodes.push(
        <Text key={key} className="text-primary underline" userSelect selectable>
          {`${m[8]}(${m[9]})`}
        </Text>,
      );
    } else if (m[11] !== undefined) {
      nodes.push(
        <Text key={key} className="line-through">
          {m[11]}
        </Text>,
      );
    }
    last = pattern.lastIndex;
  }
  if (last < raw.length) nodes.push(raw.slice(last));
  return nodes;
}

export default function MarkdownText({ content, baseClass = 'text-sm leading-relaxed' }: MarkdownTextProps) {
  if (!content) return null;

  const lines = content.split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let bk = 0;

  const pushBlock = (node: ReactNode) => {
    blocks.push(<View key={`b-${bk++}`}>{node}</View>);
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 空行：作为块间距（跳过，不渲染）
    if (trimmed === '') {
      i += 1;
      continue;
    }

    // ``` 代码块：收集到闭合 ``` 或文末（流式未闭合时把剩余全部当代码）
    if (trimmed.startsWith('```')) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过闭合 ```
      pushBlock(
        <View className="bg-muted rounded-lg px-2 py-2 my-1">
          <Text className="font-mono text-xs break-all" userSelect selectable>
            {codeLines.join('\n')}
          </Text>
        </View>,
      );
      continue;
    }

    // 分割线
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
      pushBlock(<View className="h-px bg-border my-2" />);
      i += 1;
      continue;
    }

    // 标题 # ~ ####
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const sizeClass =
        level === 1 ? 'text-base font-bold' : level === 2 ? 'text-sm font-bold' : 'text-sm font-semibold';
      pushBlock(
        <Text className={`${sizeClass} text-foreground mt-1 mb-1 block`}>
          {parseInline(headingMatch[2], `h${bk}`)}
        </Text>,
      );
      i += 1;
      continue;
    }

    // 引用 >
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      pushBlock(
        <View className="border-l-2 border-border pl-2 py-1 my-1 bg-muted rounded-r-lg">
          <Text className={`${baseClass} text-muted-foreground`}>
            {parseInline(quoteLines.join(' '), `q${bk}`)}
          </Text>
        </View>,
      );
      continue;
    }

    // 无序列表（连续行合并成一个列表块）
    if (/^[-•*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-•*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-•*]\s+/, ''));
        i += 1;
      }
      pushBlock(
        <View className="my-1">
          {items.map((it, idx) => (
            <View key={`ul-${idx}`} className="flex flex-row items-start mb-1">
              <Text className={`${baseClass} text-primary mr-2`}>•</Text>
              <View style={{ flex: 1 }}>
                <Text className={`${baseClass} text-foreground`}>{parseInline(it, `ul${bk}-${idx}`)}</Text>
              </View>
            </View>
          ))}
        </View>,
      );
      continue;
    }

    // 有序列表
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: Array<{ num: string; text: string }> = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        const mm = lines[i].trim().match(/^(\d+)[.)]\s+(.*)$/);
        if (mm) items.push({ num: mm[1], text: mm[2] });
        i += 1;
      }
      pushBlock(
        <View className="my-1">
          {items.map((it, idx) => (
            <View key={`ol-${idx}`} className="flex flex-row items-start mb-1">
              <Text className={`${baseClass} text-primary mr-2 font-medium`}>{`${it.num}.`}</Text>
              <View style={{ flex: 1 }}>
                <Text className={`${baseClass} text-foreground`}>{parseInline(it.text, `ol${bk}-${idx}`)}</Text>
              </View>
            </View>
          ))}
        </View>,
      );
      continue;
    }

    // 普通段落：连续非特殊行合并为一段（保留软换行）
    const paraLines: string[] = [];
    while (i < lines.length) {
      const t = lines[i].trim();
      if (
        t === '' ||
        t.startsWith('```') ||
        /^(#{1,4})\s+/.test(t) ||
        /^[-•*]\s+/.test(t) ||
        /^\d+[.)]\s+/.test(t) ||
        t.startsWith('>') ||
        /^(-{3,}|_{3,}|\*{3,})$/.test(t)
      ) {
        break;
      }
      paraLines.push(t);
      i += 1;
    }
    pushBlock(
      <Text className={`${baseClass} text-foreground`}>
        {paraLines.flatMap((pl, idx) => {
          const inline = parseInline(pl, `p${bk}-${idx}`);
          return idx < paraLines.length - 1 ? [...inline, '\n'] : inline;
        })}
      </Text>,
    );
  }

  return <View className="w-full">{blocks}</View>;
}
