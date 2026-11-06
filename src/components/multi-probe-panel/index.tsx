import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import type { DiagnoseResult } from '@/api/net-diagnose';

interface IpGeo {
  country?: string;
  region?: string;
  city?: string;
  isp?: string;
  source: string;
}

interface ProbeNode {
  node: string;
  region: string;
  ips: string[];
  ipGeo?: Record<string, IpGeo>;
  latencyMs: number;
  error?: string;
}

interface ThirdPartyProbe {
  country: string;
  region: string;
  city: string;
  isp: string;
  dnsIp?: string;
  pingTime?: number;
  lostRate?: number;
}

interface Props {
  result: DiagnoseResult;
}

/** 地理归属简写：国家·省份·城市 */
function geoLabel(geo: IpGeo): string {
  const parts = [geo.country, geo.region, geo.city].filter((s) => !!s);
  return parts.length > 0 ? parts.join('·') : (geo.isp ?? '');
}

/** 从 multiprobe 结果的 detail.nodes 中安全取出节点列表 */
function extractNodes(result: DiagnoseResult): ProbeNode[] {
  const nodes = result.detail?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.filter(
    (n): n is ProbeNode =>
      !!n && typeof n === 'object' && typeof (n as ProbeNode).node === 'string',
  );
}

function nodeDotColor(n: ProbeNode): string {
  if (n.error) return '#dc2626';
  return n.ips.length > 0 ? '#16a34a' : '#d97706';
}

/** 从 detail.thirdParty 中安全取出第三方拨测结果 */
function extractThirdParty(result: DiagnoseResult): { ok: boolean; provider: string; probes: ThirdPartyProbe[]; error?: string } | null {
  const tp = result.detail?.thirdParty;
  if (!tp || typeof tp !== 'object') return null;
  const t = tp as { ok?: boolean; provider?: string; probes?: unknown; error?: string };
  const probes = Array.isArray(t.probes)
    ? t.probes.filter(
        (p): p is ThirdPartyProbe => !!p && typeof p === 'object' && typeof (p as ThirdPartyProbe).isp === 'string',
      )
    : [];
  return { ok: !!t.ok, provider: t.provider ?? '', probes, error: t.error };
}

export default function MultiProbePanel({ result }: Props) {
  const [ceExpanded, setCeExpanded] = useState(false);
  const nodes = extractNodes(result);
  const thirdParty = extractThirdParty(result);
  if (nodes.length === 0 && (!thirdParty || !thirdParty.ok)) return null;

  const distinctSegments = Array.isArray(result.detail?.distinctSegments)
    ? (result.detail.distinctSegments as string[])
    : [];

  return (
    <View className="bg-card border border-border rounded-lg p-4 mb-3">
      <View className="flex flex-row items-center justify-between mb-3">
        <Text className="text-foreground text-sm font-bold">
          {thirdParty?.ok ? `${thirdParty.provider} 真实多地拨测` : '拨测节点视角对比'}
        </Text>
        <Text className="text-muted-foreground text-xs">
          {thirdParty?.ok
            ? `${thirdParty.probes.length} 个探测点`
            : distinctSegments.length > 1
              ? `${distinctSegments.length} 个调度网段`
              : '单一调度网段'}
        </Text>
      </View>

      {/* 第三方真实多地拨测明细（配置密钥后展示） */}
      {thirdParty?.ok ? (
        <View className="space-y-3">
          {thirdParty.probes.map((p, idx) => {
            const loss = p.lostRate ?? 0;
            const dot = p.pingTime === undefined ? '#d97706' : loss > 0 ? '#dc2626' : '#16a34a';
            return (
              <View key={`${p.region}-${p.isp}-${idx}`} className="flex flex-row items-start">
                <View className="flex flex-row items-center mr-3" style={{ minWidth: '150px' }}>
                  <View className="w-2 h-2 rounded-full mr-2 mt-1" style={{ backgroundColor: dot }} />
                  <View className="flex flex-col">
                    <Text className="text-foreground text-xs font-medium">
                      {[p.region, p.city].filter((s) => !!s).join('·') || p.country || '未知地点'}
                    </Text>
                    <Text className="text-muted-foreground text-xs">{p.isp}</Text>
                  </View>
                </View>
                <View className="flex-1 flex flex-row flex-wrap items-center">
                  {p.dnsIp ? (
                    <View className="px-2 py-1 rounded mr-2" style={{ backgroundColor: 'rgba(14, 165, 233, 0.08)' }}>
                      <Text className="text-primary text-xs">{p.dnsIp}</Text>
                    </View>
                  ) : null}
                  <Text className="text-foreground text-xs mr-2">
                    {p.pingTime !== undefined ? `${p.pingTime.toFixed(1)}ms` : '延迟未知'}
                  </Text>
                  <Text className={loss > 0 ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
                    丢包 {loss}%
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      ) : (
        <View className="space-y-3">
          {nodes.map((n) => (
            <View key={n.node} className="flex flex-row items-start">
              {/* 状态点 + 节点名 */}
              <View className="flex flex-row items-center mr-3" style={{ minWidth: '150px' }}>
                <View className="w-2 h-2 rounded-full mr-2 mt-2" style={{ backgroundColor: nodeDotColor(n) }} />
                <View className="flex flex-col">
                  <Text className="text-foreground text-xs font-medium">{n.node}</Text>
                  <Text className="text-muted-foreground text-xs">{n.region}</Text>
                </View>
              </View>
              {/* IP（含地理归属）/ 错误明细 */}
              <View className="flex-1 flex flex-col">
                {n.error ? (
                  <Text className="text-destructive text-xs" style={{ wordBreak: 'break-all' }}>
                    {n.error}
                  </Text>
                ) : n.ips.length > 0 ? (
                  <View className="flex flex-row flex-wrap">
                    {n.ips.map((ip) => {
                      const geo = n.ipGeo?.[ip];
                      return (
                        <View
                          key={ip}
                          className="px-2 py-1 rounded mr-2 mb-1"
                          style={{ backgroundColor: 'rgba(14, 165, 233, 0.08)' }}
                        >
                          <Text className="text-primary text-xs">{ip}</Text>
                          {geo ? (
                            <Text className="text-muted-foreground text-xs block">{geoLabel(geo)}</Text>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                ) : (
                  <Text className="text-muted-foreground text-xs">无 A 记录</Text>
                )}
                <Text className="text-muted-foreground text-xs mt-1">{n.latencyMs}ms</Text>
              </View>
            </View>
          ))}
        </View>
      )}

      {/* 结论与限制说明 */}
      <View className="border-t border-border mt-3 pt-3">
        <Text className="text-foreground text-xs" style={{ wordBreak: 'break-all' }}>
          {result.summary}
        </Text>
        {typeof result.detail?.ceNote === 'string' && (
          <View className="mt-2">
            {/* 17CE 未生效提示：默认折叠为一行，点击展开完整原因 */}
            <View
              className="flex flex-row items-center"
              onClick={() => setCeExpanded((v) => !v)}
            >
              <View className="i-mdi-information-outline w-4 h-4 text-muted-foreground mr-1" />
              <Text className="text-muted-foreground text-xs">
                {ceExpanded ? '17CE 增强源未生效（点击收起）' : '17CE 增强源未生效（点击查看原因）'}
              </Text>
              <View
                className={ceExpanded ? 'i-mdi-chevron-up w-4 h-4 text-muted-foreground ml-1' : 'i-mdi-chevron-down w-4 h-4 text-muted-foreground ml-1'}
              />
            </View>
            {ceExpanded && (
              <Text className="text-muted-foreground text-xs mt-1 block pl-5" style={{ wordBreak: 'break-all' }}>
                {result.detail.ceNote}
              </Text>
            )}
          </View>
        )}
        {typeof result.detail?.limitation === 'string' && (
          <Text className="text-muted-foreground text-xs mt-2 block" style={{ wordBreak: 'break-all' }}>
            {result.detail.limitation}
          </Text>
        )}
      </View>
    </View>
  );
}
