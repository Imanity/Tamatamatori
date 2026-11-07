import type { ShootingPlan } from "../domain/plan";
import type { WeatherFeed } from "./useWeather";
import { weatherModels } from "../domain/weather";

export function weatherMessage(feed: WeatherFeed) {
  if (feed.phase === "off") return "天气效果已关闭";
  if (feed.phase === "loading") return "正在读取天气数据";
  if (feed.phase === "stale") return "天气数据已过期，正在更新";
  if (feed.phase === "outside") return "拍摄时间超出天气预报范围";
  if (feed.phase === "missing") return "拍摄时刻缺少有效天气数据";
  if (feed.phase === "error") return feed.message ?? "天气数据读取失败";
  return "天气已应用 · 云层与降水示意";
}
const time = (value: number, zone: string) => new Intl.DateTimeFormat("zh-CN", {
  timeZone: zone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(value);

export function WeatherActions({ feed, update }: { feed: WeatherFeed; update: (patch: Partial<ShootingPlan>) => void }) {
  return <>
    {feed.phase === "error" && <button type="button" onClick={feed.retry}>重试天气</button>}
    {feed.phase === "outside" && <button type="button" onClick={() => update({ instant: new Date().toISOString() })}>使用当前时间</button>}
  </>;
}

export function WeatherReadout({ feed, plan, update }: {
  feed: WeatherFeed; plan: ShootingPlan; update: (patch: Partial<ShootingPlan>) => void;
}) {
  const sample = feed.sample, forecast = feed.forecast;
  return <section className="weather-readout" aria-label="当地天气数据" data-weather-phase={feed.phase}>
    <h3>天气</h3>
    <p role="status">{weatherMessage(feed)}</p>
    {feed.phase !== "off" && <p>模型 {weatherModels[plan.weatherModel ?? "best_match"]}</p>}
    {sample && <>
      <p>总云量 {(sample.cloud * 100).toFixed(0)}% · 低 {(sample.low * 100).toFixed(0)}% / 中 {(sample.mid * 100).toFixed(0)}% / 高 {(sample.high * 100).toFixed(0)}%</p>
      <p className="sky-limit">低、中、高云分层显示 · 云高与形态为示意 · 雨雪动态预览</p>
      <p>降水 {sample.precipitation.toFixed(1)} mm/小时 · 概率 {(sample.probability * 100).toFixed(0)}% · 能见度 {sample.visibility === null ? "模型未提供" : `${(sample.visibility / 1000).toFixed(1)} km`}</p>
      <p>拍摄 {time(sample.time, plan.timeZone)} · {plan.timeZone}</p>
    </>}
    {forecast && feed.phase !== "off" && <>
      <p>预报 {time(forecast.hours[0].time, plan.timeZone)} — {time(forecast.hours.at(-1)!.time, plan.timeZone)}</p>
      <p>获取 {time(forecast.fetchedAt, plan.timeZone)} · 起报批次未提供</p>
    </>}
    {feed.phase !== "off" && <p className="sky-limit"><a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a> · 点位云量驱动示意 · 云块方位与透光为近似</p>}
    <WeatherActions feed={feed} update={update} />
  </section>;
}
