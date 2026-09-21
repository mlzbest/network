/**
 * 双端 SSE（Server-Sent Events）请求封装。
 *
 * - H5：基于 fetch + ReadableStream
 * - 微信小程序：基于 Taro.request 的 enableChunked + onChunkReceived
 *
 * 微信小程序运行时没有 TextDecoder / EventSource / AbortController，
 * 这里手写 UTF-8 stream decoder 与 SSE 行解析逻辑保证兼容。
 */

import Taro from '@tarojs/taro'
import { isH5 } from './platform'

export interface SseEvent {
  /** SSE event 字段，未指定时为 'message' */
  event: string
  /** SSE id 字段 */
  id?: string
  /** 多行 data 拼接后的载荷（按 SSE 规范以 \n 连接） */
  data: string
}

export interface SseRequestOptions {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  headers?: Record<string, string>
  /** 请求体：对象会被 JSON 序列化（同时自动补 Content-Type: application/json） */
  body?: unknown
  /** 接收到一个完整 SSE 事件时触发 */
  onMessage?: (event: SseEvent) => void
  /** 响应头到达时触发（H5 在 fetch 解析后回调） */
  onOpen?: (status: number, headers: Record<string, string>) => void
  /** 网络错误 / HTTP 非 2xx / 解析失败时触发 */
  onError?: (err: unknown) => void
  /** 流正常结束时触发 */
  onDone?: () => void
}

export interface SseRequestHandle {
  abort: () => void
}

/** 增量 UTF-8 解码器（跨端） */
export interface StreamDecoder {
  decode(chunk: ArrayBuffer | Uint8Array): string
  flush(): string
}

export function createStreamDecoder(): StreamDecoder {
  if (typeof TextDecoder !== 'undefined') {
    const decoder = new TextDecoder('utf-8')
    return {
      decode: (chunk) => decoder.decode(chunk as ArrayBuffer, { stream: true }),
      flush: () => decoder.decode(),
    }
  }

  let pending = new Uint8Array(0)

  const decodeBytes = (bytes: Uint8Array): string => {
    let result = ''
    let i = 0
    while (i < bytes.length) {
      const b1 = bytes[i]
      if (b1 < 0x80) {
        result += String.fromCharCode(b1)
        i += 1
      } else if (b1 < 0xc0) {
        result += '�'
        i += 1
      } else if (b1 < 0xe0) {
        const b2 = bytes[i + 1]
        if (b2 === undefined) { result += '�'; break }
        result += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f))
        i += 2
      } else if (b1 < 0xf0) {
        const b2 = bytes[i + 1]
        const b3 = bytes[i + 2]
        if (b2 === undefined || b3 === undefined) { result += '�'; break }
        result += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f))
        i += 3
      } else if (b1 < 0xf8) {
        const b2 = bytes[i + 1]
        const b3 = bytes[i + 2]
        const b4 = bytes[i + 3]
        if (b2 === undefined || b3 === undefined || b4 === undefined) { result += '�'; break }
        const cp = ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f)
        result += String.fromCodePoint(cp)
        i += 4
      } else {
        result += '�'
        i += 1
      }
    }
    return result
  }

  return {
    decode(chunk) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      const merged = new Uint8Array(pending.length + bytes.length)
      merged.set(pending, 0)
      merged.set(bytes, pending.length)

      let cut = merged.length
      let i = merged.length - 1
      while (i >= 0 && (merged[i] & 0xc0) === 0x80) i--
      if (i >= 0) {
        const start = merged[i]
        let expected = 1
        if ((start & 0x80) === 0) expected = 1
        else if ((start & 0xe0) === 0xc0) expected = 2
        else if ((start & 0xf0) === 0xe0) expected = 3
        else if ((start & 0xf8) === 0xf0) expected = 4
        if (merged.length - i < expected) cut = i
      }

      pending = merged.slice(cut)
      return decodeBytes(merged.subarray(0, cut))
    },
    flush() {
      if (pending.length === 0) return ''
      const tail = decodeBytes(pending)
      pending = new Uint8Array(0)
      return tail
    },
  }
}

/**
 * SSE 事件解析：按 SSE 规范以空行（\n\n）切分事件，
 * 同一事件内多行 data 以 \n 拼接，忽略以 ':' 开头的注释行。
 */
export interface SseEventParser {
  push(text: string, onEvent: (event: SseEvent) => void): void
  flush(onEvent: (event: SseEvent) => void): void
}

export function createSseEventParser(): SseEventParser {
  // 兼容 \r\n、\r、\n
  let buffer = ''

  const parseEvent = (raw: string): SseEvent | null => {
    let eventName = 'message'
    let id: string | undefined
    const dataLines: string[] = []
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'data') dataLines.push(value)
      else if (field === 'event') eventName = value
      else if (field === 'id') id = value
    }
    if (dataLines.length === 0) return null
    return { event: eventName, id, data: dataLines.join('\n') }
  }

  const drain = (chunk: string, onEvent: (event: SseEvent) => void) => {
    const normalized = chunk.replace(/\r\n?/g, '\n')
    const parts = normalized.split('\n\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const ev = parseEvent(part)
      if (ev) onEvent(ev)
    }
  }

  return {
    push(text, onEvent) {
      drain(buffer + text, onEvent)
    },
    flush(onEvent) {
      const tail = buffer
      buffer = ''
      if (!tail) return
      const ev = parseEvent(tail)
      if (ev) onEvent(ev)
    },
  }
}

interface PreparedBody {
  body: unknown
  headers: Record<string, string>
}

function prepareBody(body: unknown, headers: Record<string, string>): PreparedBody {
  if (body === undefined || body === null) return { body: undefined, headers }
  if (typeof body === 'string') return { body, headers }
  if (body instanceof ArrayBuffer) return { body, headers }
  const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
  const next = hasContentType ? headers : { ...headers, 'Content-Type': 'application/json' }
  return { body: JSON.stringify(body), headers: next }
}

function buildDefaultHeaders(custom?: Record<string, string>): Record<string, string> {
  const hasAccept = custom && Object.keys(custom).some((k) => k.toLowerCase() === 'accept')
  return hasAccept ? { ...custom } : { Accept: 'text/event-stream', ...(custom ?? {}) }
}

/**
 * 发起 SSE 请求，跨端兼容（H5 / 微信小程序）。
 * 返回的 handle 可调用 `abort()` 主动中断。
 */
export function sseRequest(options: SseRequestOptions): SseRequestHandle {
  const {
    url,
    method = 'POST',
    headers: rawHeaders,
    body,
    onMessage,
    onOpen,
    onError,
    onDone,
  } = options

  const headers = buildDefaultHeaders(rawHeaders)
  const prepared = prepareBody(body, headers)

  const decoder = createStreamDecoder()
  const parser = createSseEventParser()

  const dispatch = (text: string) => {
    if (!text) return
    parser.push(text, (ev) => {
      try {
        onMessage?.(ev)
      } catch (err) {
        onError?.(err)
      }
    })
  }

  let aborted = false

  if (isH5()) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null

    ;(async () => {
      try {
        const res = await fetch(url, {
          method,
          headers: prepared.headers,
          body: prepared.body as BodyInit | undefined,
          signal: controller?.signal,
        })

        const headerObj: Record<string, string> = {}
        res.headers.forEach((v, k) => { headerObj[k] = v })
        onOpen?.(res.status, headerObj)

        if (!res.ok) {
          const text = await res.text().catch(() => '')
          onError?.(new Error(`SSE HTTP ${res.status}: ${text || res.statusText}`))
          return
        }

        if (!res.body) {
          const text = await res.text()
          dispatch(text)
          parser.flush((ev) => onMessage?.(ev))
          onDone?.()
          return
        }

        const reader = res.body.getReader()
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (aborted) break
          const { value, done } = await reader.read()
          if (done) break
          if (value) dispatch(decoder.decode(value))
        }
        const tail = decoder.flush()
        if (tail) dispatch(tail)
        parser.flush((ev) => onMessage?.(ev))
        onDone?.()
      } catch (err: any) {
        if (aborted || err?.name === 'AbortError') return
        onError?.(err)
      }
    })()

    return {
      abort: () => {
        aborted = true
        controller?.abort()
      },
    }
  }

  // 小程序：Taro.request + enableChunked
  const task = Taro.request({
    url,
    method,
    header: prepared.headers,
    data: prepared.body as any,
    enableChunked: true,
    responseType: 'text',
    success: (res) => {
      const tail = decoder.flush()
      if (tail) dispatch(tail)
      parser.flush((ev) => onMessage?.(ev))
      if (typeof res.statusCode === 'number' && (res.statusCode < 200 || res.statusCode >= 300)) {
        onError?.(new Error(`SSE HTTP ${res.statusCode}`))
        return
      }
      onDone?.()
    },
    fail: (err) => {
      if (aborted) return
      onError?.(err)
    },
  })

  task.onHeadersReceived?.((res) => {
    const header = (res.header ?? {}) as Record<string, string>
    const status = Number(header['Status']?.split(' ')[0]) || 200
    onOpen?.(status, header)
  })

  task.onChunkReceived?.((res) => {
    if (aborted) return
    dispatch(decoder.decode(res.data))
  })

  return {
    abort: () => {
      aborted = true
      task.abort?.()
    },
  }
}
