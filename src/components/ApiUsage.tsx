import { useEffect, useState } from "react";
import { OPEN_METEO_LIMITS, usageTotals } from "../domain/api-usage";
import { openMeteoUsage, subscribeUsage } from "../preview/api-usage";
import { Detail } from "./readout";

/** This browser's Open-Meteo log, refreshed on every request and each half minute for the rolling windows. */
function useOpenMeteoUsage() {
  const [state, setState] = useState(() => ({ log: openMeteoUsage(), now: Date.now() }));
  useEffect(() => {
    const refresh = () => setState({ log: openMeteoUsage(), now: Date.now() });
    const stop = subscribeUsage(refresh);
    const timer = setInterval(refresh, 30_000);
    return () => { stop(); clearInterval(timer); };
  }, []);
  return state;
}

const count = (value: number) => (Number.isInteger(value) ? value : value.toFixed(1)).toLocaleString("zh-CN");

/**
 * Calls this browser made to Open-Meteo in the last minute, hour and day.
 * The service counts per IP: other devices on the same network and other
 * apps are not visible here.
 */
export function OpenMeteoUsage({ active }: { active: boolean }) {
  const { log, now } = useOpenMeteoUsage();
  const totals = usageTotals(log, now);
  if (!active && totals.day === 0 && !log.limitedUntil) return null;
  const limited = !!log.limitedUntil && log.limitedUntil > now;
  const near = totals.day >= OPEN_METEO_LIMITS.day * 0.8 || totals.hour >= OPEN_METEO_LIMITS.hour * 0.8 || totals.minute >= OPEN_METEO_LIMITS.minute * 0.8;
  const server = log.server && log.server.reset > now ? log.server : null;
  return <p className="api-usage" data-usage={limited ? "limited" : near ? "near" : "ok"} aria-label="Open-Meteo 用量">
    Open-Meteo 用量（本浏览器）：近 24 小时约 {count(totals.day)} / {count(OPEN_METEO_LIMITS.day)} 次
    {limited ? `；已限流，约 ${Math.ceil((log.limitedUntil! - now) / 1000)} 秒后恢复` : near ? "；接近免费上限" : ""}
    <Detail>
      近 1 小时 {count(totals.hour)} / {count(OPEN_METEO_LIMITS.hour)} · 近 1 分钟 {count(totals.minute)} / {count(OPEN_METEO_LIMITS.minute)}
      {server ? ` · 同一 IP 本分钟剩余 ${count(server.remaining)}` : ""}
      {" · "}按访问者 IP 计数，同一网络的其他设备与其他使用 Open-Meteo 的应用也计入，这里看不到 · 每次读取约计：天气 1.2 次、自动匹配来源 1.6 次、潮汐 13 次（按查询的坐标数估算）
    </Detail>
  </p>;
}
