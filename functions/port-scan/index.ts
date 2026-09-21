/**
 * Port Scan Edge Function
 *
 * 使用 Deno.connect 探测指定端口的 TCP 连接状态。
 * 部署：edge-runtime deploy --name port-scan
 */

interface PortScanRequest {
  host: string;
  ports?: number[];
}

interface PortResult {
  port: number;
  status: 'open' | 'closed' | 'timeout';
  responseTime?: number;
}

interface PortScanResult {
  host: string;
  ports: PortResult[];
  openCount: number;
  closedCount: number;
}

const DEFAULT_PORTS = [21, 22, 53, 80, 443, 8080, 8443, 3306, 5432, 6379, 27017];
const PORT_TIMEOUT_MS = 2000; // 每个端口超时 2 秒

Deno.serve(handleRequest);

async function handleRequest(req: Request): Promise<Response> {
  const functionName = 'port-scan';
  const headers = { 'Content-Type': 'application/json' };

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: '仅支持 POST 请求' }), { status: 405, headers });
  }

  try {
    const { host, ports = DEFAULT_PORTS }: PortScanRequest = await req.json();
    console.info(`[${functionName}] scanning host=${host} ports=${ports.join(',')}`);

    if (!host || typeof host !== 'string') {
      return new Response(JSON.stringify({ error: '缺少 host 参数' }), { status: 400, headers });
    }

    const validPattern = /^[a-zA-Z0-9.\-:]+$/;
    if (!validPattern.test(host)) {
      return new Response(JSON.stringify({ error: '无效的域名或IP格式' }), { status: 400, headers });
    }

    if (!Array.isArray(ports) || ports.length === 0) {
      return new Response(JSON.stringify({ error: '请提供要扫描的端口列表' }), { status: 400, headers });
    }

    const results: PortResult[] = [];

    for (const port of ports) {
      const result = await probePort(host, port);
      results.push(result);
      await new Promise(r => setTimeout(r, 50));
    }

    const openCount = results.filter(r => r.status === 'open').length;
    const closedCount = results.filter(r => r.status === 'closed' || r.status === 'timeout').length;

    const scanResult: PortScanResult = { host, ports: results, openCount, closedCount };
    console.info(`[${functionName}] scanned ${ports.length} ports, open=${openCount}, closed=${closedCount}`);
    return new Response(JSON.stringify(scanResult), { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${functionName}] failed: ${message}`);
    return new Response(JSON.stringify({ error: message }), { status: 500, headers });
  }
}

async function probePort(host: string, port: number): Promise<PortResult> {
  const startTime = Date.now();
  try {
    const conn = await Promise.race([
      Deno.connect({ hostname: host, port, transport: 'tcp' }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), PORT_TIMEOUT_MS)
      )
    ]);
    const responseTime = Date.now() - startTime;
    conn.close();
    return { port, status: 'open', responseTime };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errName = error instanceof Error ? error.name : 'unknown';
    const errMsg = error instanceof Error ? error.message : '';
    return { 
      port, 
      status: (errName === 'ConnectionRefused' || errName === 'NetworkUnreachable' || errMsg === 'timeout') ? 'closed' : 'timeout',
      responseTime 
    };
  }
}
