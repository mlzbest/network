/**
 * DNS Lookup Edge Function
 *
 * 使用 Deno 原生 DNS 解析进行查询，支持 A/AAAA/MX/NS/CNAME 记录类型。
 * 添加超时机制防止卡死。
 */

const DNS_TIMEOUT_MS = 5000; // DNS 查询超时 5 秒

interface DnsRequest {
  host: string;
  type?: 'A' | 'AAAA' | 'MX' | 'NS' | 'CNAME';
}

interface DnsRecord {
  name: string;
  type: string;
  class: string;
  ttl: number;
  data: string;
}

interface DnsResult {
  query: string;
  recordType: string;
  records: DnsRecord[];
  error?: string;
}

Deno.serve(handleRequest);

async function handleRequest(req: Request): Promise<Response> {
  const functionName = 'dns-lookup';
  const headers = { 'Content-Type': 'application/json' };

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: '仅支持 POST 请求' }), { status: 405, headers });
  }

  try {
    const { host, type = 'A' }: DnsRequest = await req.json();
    console.info(`[${functionName}] query host=${host} type=${type}`);

    if (!host || typeof host !== 'string') {
      return new Response(JSON.stringify({ error: '缺少 host 参数' }), { status: 400, headers });
    }

    const validPattern = /^[a-zA-Z0-9.\-:]+$/;
    if (!validPattern.test(host)) {
      return new Response(JSON.stringify({ error: '无效的域名格式' }), { status: 400, headers });
    }

    const records: DnsRecord[] = [];
    
    // Use Deno.resolveDns for DNS resolution with timeout
    try {
      const results = await withTimeout(
        performDnsQuery(host, type),
        DNS_TIMEOUT_MS
      );
      
      for (const record of results) {
        records.push(record);
      }
      
      console.info(`[${functionName}] found ${records.length} records for ${host}`);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`[${functionName}] DNS resolution failed: ${errMsg}`);
      // 所有 DNS 查询失败都返回空结果，不报错
      return new Response(JSON.stringify({ 
        query: host, 
        recordType: type, 
        records: [],
        error: errMsg
      }), { status: 200, headers });
    }

    const result: DnsResult = { query: host, recordType: type, records };
    return new Response(JSON.stringify(result), { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${functionName}] failed: ${message}`);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers });
  }
}

/**
 * 执行 DNS 查询，根据类型调用不同的 Deno API
 */
async function performDnsQuery(host: string, type: string): Promise<DnsRecord[]> {
  const records: DnsRecord[] = [];
  
  switch (type) {
    case 'A': {
      const results = await Deno.resolveDns(host, 'A');
      for (const addr of results) {
        records.push({ name: host, type: 'A', class: 'IN', ttl: 0, data: addr });
      }
      break;
    }
    case 'AAAA': {
      const results = await Deno.resolveDns(host, 'AAAA');
      for (const addr of results) {
        records.push({ name: host, type: 'AAAA', class: 'IN', ttl: 0, data: addr });
      }
      break;
    }
    case 'CNAME': {
      const results = await Deno.resolveDns(host, 'CNAME');
      for (const cname of results) {
        records.push({ name: host, type: 'CNAME', class: 'IN', ttl: 0, data: cname });
      }
      break;
    }
    case 'MX': {
      // MX 返回对象数组 { preference, exchange }
      const mxResults = await Deno.resolveDns(host, 'MX');
      for (const mx of mxResults as any[]) {
        const preference = mx.preference || 0;
        const exchange = mx.exchange || '';
        records.push({ name: host, type: 'MX', class: 'IN', ttl: 0, data: `${preference} ${exchange}` });
      }
      break;
    }
    case 'NS': {
      const results = await Deno.resolveDns(host, 'NS');
      for (const ns of results) {
        records.push({ name: host, type: 'NS', class: 'IN', ttl: 0, data: ns });
      }
      break;
    }
    default:
      const results = await Deno.resolveDns(host, 'A');
      for (const addr of results) {
        records.push({ name: host, type: 'A', class: 'IN', ttl: 0, data: addr });
      }
  }
  
  return records;
}

/**
 * 带超时的 Promise 包装
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
    )
  ]);
}
