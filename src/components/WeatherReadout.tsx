import type { ShootingPlan } from "../domain/plan";
import type { WeatherFeed } from "./useWeather";
import { cloudLevel } from "./readout";

export function weatherMessage(feed: WeatherFeed) {
  if (feed.phase === "off") return "天气效果已关闭";
  if (feed.phase === "loading") return "正在读取天气数据";
  if (feed.phase === "stale") return "天气数据已过期，正在更新";
  if (feed.phase === "outside") return "拍摄时间超出天气预报范围";
  if (feed.phase === "missing") return "拍摄时刻缺少有效天气数据";
  if (feed.phase === "error") return feed.message ?? "天气数据读取失败";
  return "天气已应用";
}
export function WeatherActions({ feed, update }: { feed: WeatherFeed; update: (patch: Partial<ShootingPlan>) => void }) {
  return <>
    {feed.phase === "error" && <button type="button" onClick={feed.retry}>重试天气</button>}
    {feed.phase === "outside" && <button type="button" onClick={() => update({ instant: new Date().toISOString() })}>使用当前时间</button>}
  </>;
}

export function WeatherReadout({ feed, update }: {
  feed: WeatherFeed; update: (patch: Partial<ShootingPlan>) => void;
}) {
  const sample = feed.sample;
  // Conclusion first: sky cover in words and the chance of precipitation.
  const summary = feed.phase === "ready" && sample
    ? `${cloudLevel(sample.cloud)} · 降水概率 ${(sample.probability * 100).toFixed(0)}%`
    : weatherMessage(feed);
  return <section className="weather-readout" aria-label="当地天气数据" data-weather-phase={feed.phase}>
    <p role="status">{summary}</p>
    {sample && <>
      <p className="info-detail">总云量 {(sample.cloud * 100).toFixed(0)}% · 低 {(sample.low * 100).toFixed(0)}% / 中 {(sample.mid * 100).toFixed(0)}% / 高 {(sample.high * 100).toFixed(0)}%</p>
      <p className="info-detail">降水 {sample.precipitation.toFixed(1)} mm/小时 · 概率 {(sample.probability * 100).toFixed(0)}% · 能见度 {sample.visibility === null ? "模型未提供" : `${(sample.visibility / 1000).toFixed(1)} km`}</p>
    </>}
    {feed.phase !== "off" && <p className="weather-source">天气数据来自 <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a></p>}
    <WeatherActions feed={feed} update={update} />
  </section>;
}
