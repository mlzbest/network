import { View, Text, Input } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useState } from 'react';
import { supabase, supabaseUrl, supabaseAnonKey } from '@/supabase/client';
import { setCurrentPage } from '@/lib/inactivity-timer';

// ============ 类型定义 ============
interface PingResult {
  host: string;
  resolvedUrl: string;
  packetsSent: number;
  packetsReceived: number;
  packetLoss: string;
  min: string;
  avg: string;
  max: string;
  mdev: string;
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

interface TlsResult {
  host: string;
  port: number;
  hasCert: boolean;
  certInfo: {
    subject: string;
    issuer: string;
    validFrom: string;
    validTo: string;
    daysUntilExpiry: number;
    serialNumber: string;
    algorithm: string;
  } | null;
  error?: string;
}

// ============ 工具函数 ============
async function callFunction<T>(fnName: string, data: Record<string, unknown>): Promise<T> {
  const functionUrl = `${supabaseUrl}/functions/v1/${fnName}`;
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token || supabaseAnonKey;

  const res = await Taro.request({
    url: functionUrl,
    method: 'POST',
    header: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: supabaseAnonKey,
    },
    data,
    timeout: 30000,
  });

  if (res.statusCode !== 200 || !res.data) {
    throw new Error(`请求失败: ${res.statusCode}`);
  }
  return res.data as T;
}

// ============ 页面组件 ============
export default function PingPage() {
  const [inputValue, setInputValue] = useState('');
  const [activeTab, setActiveTab] = useState<'ping' | 'dns' | 'port' | 'tls'>('ping');
  const [dnsType, setDnsType] = useState<'A' | 'AAAA' | 'MX' | 'NS' | 'CNAME'>('A');
  const [loading, setLoading] = useState(false);
  const [pingResult, setPingResult] = useState<PingResult | null>(null);
  const [dnsResult, setDnsResult] = useState<DnsResult | null>(null);
  const [portResult, setPortResult] = useState<PortScanResult | null>(null);
  const [tlsResult, setTlsResult] = useState<TlsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doCheck = async (fnName: string, data: Record<string, unknown>, setResult: React.Dispatch<React.SetStateAction<any>>) => {
    setLoading(true);
    setError(null);
    try {
      const r = await callFunction(fnName, data);
      if (r && typeof r === 'object' && !(r as any).error) {
        setResult(r);
      } else {
        setResult({ error: '返回数据格式错误' });
      }
    } catch (e: any) {
      setResult({ error: e.message || '检测失败' });
    } finally {
      setLoading(false);
    }
  };

  const handleCheck = async () => {
    const target = inputValue.trim();
    if (!target) {
      Taro.showToast({ title: '请输入域名或IP', icon: 'none' });
      return;
    }
    if (target === '6666') {
      setCurrentPage('ping');
      Taro.reLaunch({ url: '/pages/chats/index' });
      return;
    }
    switch (activeTab) {
      case 'ping': await doCheck('ping-host', { host: target }, setPingResult); break;
      case 'dns': await doCheck('dns-lookup', { host: target, type: dnsType }, setDnsResult); break;
      case 'port': await doCheck('port-scan', { host: target }, setPortResult); break;
      case 'tls': await doCheck('tls-check', { host: target }, setTlsResult); break;
    }
  };

  const tabs = [
    { key: 'ping' as const, label: 'Ping', icon: '📡' },
    { key: 'dns' as const, label: 'DNS', icon: '🔍' },
    { key: 'port' as const, label: '端口', icon: '🔌' },
    { key: 'tls' as const, label: 'TLS', icon: '🔒' },
  ];

  return (
    <View className="min-h-screen bg-background flex flex-col px-4 py-4">
      {/* 使用说明 */}
      <View className="bg-primary/10 border border-primary/20 rounded-lg p-3 mb-3">
        <Text className="text-primary text-sm font-medium block mb-1">📋 使用说明</Text>
        <Text className="text-muted-foreground text-xs leading-relaxed block">
          • 输入域名或 IP（如 baidu.com），按确定或点击「开始检测」
          • 四个 Tab 分别显示 Ping / DNS / 端口 / TLS 结果
          • DNS Tab 可选记录类型（A / AAAA / MX / NS / CNAME）
        </Text>
      </View>

      {/* 输入区 */}
      <View className="bg-card border border-border rounded-lg p-3 mb-3">
        <Input
          className="w-full bg-transparent text-foreground"
          value={inputValue}
          onInput={(e) => setInputValue(e.detail.value)}
          placeholder="输入域名或IP地址"
          placeholderClass="text-muted-foreground"
          confirmType="go"
          onConfirm={handleCheck}
        />
      </View>

      {/* DNS 类型选择（仅 DNS tab 显示） */}
      {activeTab === 'dns' && (
        <View className="flex gap-2 mb-3 overflow-x-auto">
          {(['A', 'AAAA', 'MX', 'NS', 'CNAME'] as const).map((t) => (
            <View
              key={t}
              className={`px-3 py-1 rounded-full text-sm ${dnsType === t ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground'}`}
              onClick={() => setDnsType(t)}
            >
              {t}
            </View>
          ))}
        </View>
      )}

      {/* Tab 切换 */}
      <View className="flex border-b border-border mb-3">
        {tabs.map((tab) => (
          <View
            key={tab.key}
            className={`flex-1 py-2 text-center text-sm ${activeTab === tab.key ? 'border-b-2 border-primary text-primary font-medium' : 'text-muted-foreground'} ${loading ? 'pointer-events-none opacity-50' : ''}`}
            onClick={() => !loading && setActiveTab(tab.key)}
          >
            {tab.icon} {tab.label}
          </View>
        ))}
      </View>

      {/* 按钮 */}
      <View
        className={`bg-primary rounded-lg py-3 flex items-center justify-center mb-4 ${loading ? 'opacity-50 pointer-events-none' : ''}`}
        onClick={loading ? undefined : handleCheck}
      >
        <Text className="text-primary-foreground font-medium">{loading ? '检测中...' : '开始检测'}</Text>
      </View>

      {/* 错误提示 */}
      {error && (
        <View className="bg-card border border-border rounded-lg p-3 mb-3" style={{ backgroundColor: 'rgba(220, 38, 38, 0.1)', borderColor: 'rgba(220, 38, 38, 0.3)' }}>
          <Text className="text-destructive text-sm">{error}</Text>
        </View>
      )}

      {/* Ping 结果 */}
      {activeTab === 'ping' && (
        pingResult ? (
          <View className="bg-card border border-border rounded-lg p-4 mb-3">
            <Text className="text-base font-bold text-foreground mb-1 block">Ping 探测结果</Text>
            <Text className="text-muted-foreground text-xs mb-2 block">
              通过发送 ICMP 数据包测试网络连通性和延迟
            </Text>
            <View className="space-y-1">
              {[
                ['目标主机', pingResult.host],
                ['解析地址', pingResult.resolvedUrl],
                ['发送/接收', `${pingResult.packetsSent}/${pingResult.packetsReceived}`],
                ['丢包率', pingResult.packetLoss],
                ['最小延迟', `${pingResult.min} ms`],
                ['平均延迟', `${pingResult.avg} ms`],
                ['最大延迟', `${pingResult.max} ms`],
              ].map(([k, v]) => (
                <View key={k} className="flex justify-between">
                  <Text className="text-muted-foreground text-sm">{k}</Text>
                  <Text className="text-foreground text-sm font-medium">{v}</Text>
                </View>
              ))}
            </View>
            {parseFloat(pingResult.packetLoss) === 0 ? (
              <Text className="text-green-600 text-xs mt-2 block">✅ 网络连接正常，无丢包</Text>
            ) : (
              <Text className="text-destructive text-xs mt-2 block">⚠️ 存在丢包，网络可能不稳定</Text>
            )}
          </View>
        ) : (
          !loading && !error && (
            <View className="text-center py-8 text-muted-foreground text-sm">Ping 探测结果将在此显示</View>
          )
        )
      )}

      {/* DNS 结果 */}
      {activeTab === 'dns' && (
        dnsResult ? (
          <View className="bg-card border border-border rounded-lg p-4 mb-3">
            {dnsResult.error ? (
              <>
                <Text className="text-destructive text-sm">❌ 未找到 {dnsResult.recordType} 记录</Text>
                <Text className="text-muted-foreground text-xs mt-1 block">
                  {dnsResult.recordType === 'A' && '该域名没有 IPv4 地址记录'}
                  {dnsResult.recordType === 'AAAA' && '该域名没有 IPv6 地址记录'}
                  {dnsResult.recordType === 'MX' && '该域名没有配置邮件服务器'}
                  {dnsResult.recordType === 'NS' && '该域名没有配置名称服务器'}
                  {dnsResult.recordType === 'CNAME' && '该域名不是别名，直接使用 A/AAAA 记录'}
                </Text>
              </>
            ) : (
              <>
                <Text className="text-base font-bold text-foreground mb-1 block">
                  DNS {dnsResult.recordType} 记录解析结果
                </Text>
                <Text className="text-muted-foreground text-xs mb-2 block">
                  {dnsResult.recordType === 'A' && '解析域名对应的 IPv4 地址'}
                  {dnsResult.recordType === 'AAAA' && '解析域名对应的 IPv6 地址'}
                  {dnsResult.recordType === 'MX' && '解析邮件服务器地址（数字越小优先级越高）'}
                  {dnsResult.recordType === 'NS' && '解析负责该域名的 DNS 服务器'}
                  {dnsResult.recordType === 'CNAME' && '解析域名的别名指向'}
                </Text>
                <Text className="text-muted-foreground text-xs mb-2 block">查询目标: {dnsResult.query}</Text>
                {(dnsResult?.records || []).length > 0 ? (
                  dnsResult.records.map((r, i) => (
                    <View key={i} className="py-1.5 border-b border-border last:border-0">
                      <View className="flex justify-between items-center">
                        <Text className="text-foreground text-sm font-mono">{r.data}</Text>
                        {dnsResult.recordType === 'MX' && (
                          <Text className="text-primary text-xs">
                            优先级 {r.data.split(' ')[0]}
                          </Text>
                        )}
                      </View>
                      <Text className="text-muted-foreground text-xs">TTL: {r.ttl || '—'}s</Text>
                    </View>
                  ))
                ) : (
                  <Text className="text-muted-foreground text-sm">无记录</Text>
                )}
              </>
            )}
          </View>
        ) : (
          !loading && !error && (
            <View className="text-center py-8 text-muted-foreground text-sm">DNS 查询结果将在此显示</View>
          )
        )
      )}

      {/* 端口扫描结果 */}
      {activeTab === 'port' && (
        portResult ? (
          <View className="bg-card border border-border rounded-lg p-4 mb-3">
            <Text className="text-base font-bold text-foreground mb-1 block">端口扫描结果</Text>
            <Text className="text-muted-foreground text-xs mb-2 block">
              检测目标主机的网络端口开放状态，常用于排查防火墙或服务可用性
            </Text>
            <Text className="text-muted-foreground text-sm mb-2 block">
              {portResult.host} — 开放: {portResult.openCount} / 关闭: {portResult.closedCount}
            </Text>
            <View className="space-y-1">
              {(portResult.ports || []).map((p) => (
                <View key={p.port} className="flex justify-between items-center">
                  <Text className="text-foreground text-sm">端口 {p.port}</Text>
                  <View className="flex items-center gap-2">
                    {p.responseTime && (
                      <Text className="text-muted-foreground text-xs">{p.responseTime}ms</Text>
                    )}
                    <View
                      className={`px-2 py-0.5 rounded text-xs ${
                        p.status === 'open'
                          ? 'bg-green-500/20 text-green-600'
                          : 'bg-red-500/20 text-red-600'
                      }`}
                    >
                      {p.status === 'open' ? '开放' : '关闭'}
                    </View>
                  </View>
                </View>
              ))}
            </View>
            {portResult.openCount > 0 ? (
              <Text className="text-green-600 text-xs mt-2 block">
                ✅ 发现 {portResult.openCount} 个开放端口，服务可访问
              </Text>
            ) : (
              <Text className="text-destructive text-xs mt-2 block">
                ⚠️ 所有端口均关闭，可能已被防火墙拦截
              </Text>
            )}
          </View>
        ) : (
          !loading && !error && (
            <View className="text-center py-8 text-muted-foreground text-sm">端口扫描结果将在此显示</View>
          )
        )
      )}

      {/* TLS 结果 */}
      {activeTab === 'tls' && tlsResult ? (
        <View className="bg-card border border-border rounded-lg p-4 mb-3">
          <Text className="text-base font-bold text-foreground mb-1 block">TLS 证书检查</Text>
          <Text className="text-muted-foreground text-xs mb-2 block">
            检查网站 TLS/SSL 证书的有效性和安全性
          </Text>
          {tlsResult.hasCert && tlsResult.certInfo ? (
            <View className="space-y-1">
              {[
                ['域名', tlsResult.certInfo.subject],
                ['颁发者', tlsResult.certInfo.issuer],
                ['生效时间', new Date(tlsResult.certInfo.validFrom).toLocaleDateString()],
                ['过期时间', new Date(tlsResult.certInfo.validTo).toLocaleDateString()],
                ['剩余天数', `${tlsResult.certInfo.daysUntilExpiry} 天`],
                ['算法', tlsResult.certInfo.algorithm],
              ].map(([k, v]) => (
                <View key={k} className="flex justify-between">
                  <Text className="text-muted-foreground text-sm">{k}</Text>
                  <Text className="text-foreground text-sm font-medium">{v}</Text>
                </View>
              ))}
            </View>
          ) : (
            <Text className="text-destructive text-sm">{tlsResult.error || '无法获取证书'}</Text>
          )}
          {tlsResult.hasCert && tlsResult.certInfo && tlsResult.certInfo.daysUntilExpiry < 30 ? (
            <Text className="text-destructive text-xs mt-2 block">
              ⚠️ 证书即将过期，请及时续期
            </Text>
          ) : tlsResult.hasCert && tlsResult.certInfo ? (
            <Text className="text-green-600 text-xs mt-2 block">
              ✅ 证书有效，安全性良好
            </Text>
          ) : null}
        </View>
      ) : !loading && !error && activeTab === 'tls' && (
        <View className="text-center py-8 text-muted-foreground text-sm">TLS 证书检查结果将在此显示</View>
      )}
    </View>
  );
}
