// index.ts
var DEFAULT_PORTS = [
  21,
  22,
  53,
  80,
  443,
  8080,
  8443,
  3306,
  5432,
  6379,
  27017
];
var PORT_TIMEOUT_MS = 2e3;
Deno.serve(handleRequest);
async function handleRequest(req) {
  const functionName = "port-scan";
  const headers = {
    "Content-Type": "application/json"
  };
  if (req.method !== "POST") {
    return new Response(JSON.stringify({
      error: "\u4EC5\u652F\u6301 POST \u8BF7\u6C42"
    }), {
      status: 405,
      headers
    });
  }
  try {
    const { host, ports = DEFAULT_PORTS } = await req.json();
    console.info(`[${functionName}] scanning host=${host} ports=${ports.join(",")}`);
    if (!host || typeof host !== "string") {
      return new Response(JSON.stringify({
        error: "\u7F3A\u5C11 host \u53C2\u6570"
      }), {
        status: 400,
        headers
      });
    }
    const validPattern = /^[a-zA-Z0-9.\-:]+$/;
    if (!validPattern.test(host)) {
      return new Response(JSON.stringify({
        error: "\u65E0\u6548\u7684\u57DF\u540D\u6216IP\u683C\u5F0F"
      }), {
        status: 400,
        headers
      });
    }
    if (!Array.isArray(ports) || ports.length === 0) {
      return new Response(JSON.stringify({
        error: "\u8BF7\u63D0\u4F9B\u8981\u626B\u63CF\u7684\u7AEF\u53E3\u5217\u8868"
      }), {
        status: 400,
        headers
      });
    }
    const results = [];
    for (const port of ports) {
      const result = await probePort(host, port);
      results.push(result);
      await new Promise((r) => setTimeout(r, 50));
    }
    const openCount = results.filter((r) => r.status === "open").length;
    const closedCount = results.filter((r) => r.status === "closed" || r.status === "timeout").length;
    const scanResult = {
      host,
      ports: results,
      openCount,
      closedCount
    };
    console.info(`[${functionName}] scanned ${ports.length} ports, open=${openCount}, closed=${closedCount}`);
    return new Response(JSON.stringify(scanResult), {
      headers
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${functionName}] failed: ${message}`);
    return new Response(JSON.stringify({
      error: message
    }), {
      status: 500,
      headers
    });
  }
}
async function probePort(host, port) {
  const startTime = Date.now();
  try {
    const conn = await Promise.race([
      Deno.connect({
        hostname: host,
        port,
        transport: "tcp"
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), PORT_TIMEOUT_MS))
    ]);
    const responseTime = Date.now() - startTime;
    conn.close();
    return {
      port,
      status: "open",
      responseTime
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errName = error instanceof Error ? error.name : "unknown";
    const errMsg = error instanceof Error ? error.message : "";
    return {
      port,
      status: errName === "ConnectionRefused" || errName === "NetworkUnreachable" || errMsg === "timeout" ? "closed" : "timeout",
      responseTime
    };
  }
}
